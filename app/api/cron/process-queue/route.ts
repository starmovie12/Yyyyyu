import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';
import { extractMovieLinks } from '@/lib/solvers';
import { TIMER_DOMAINS, STUCK_TASK_THRESHOLD_MS, MAX_CRON_RETRIES } from '@/lib/config';
import { processLink } from '@/app/api/solve_task/route';
import { cleanupExpiredCache } from '@/lib/cache';

export const dynamic    = 'force-dynamic';
export const maxDuration = 60;

const queueCollections = ['movies_queue', 'webseries_queue'] as const;

async function sendTelegram(msg: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
    });
  } catch { /* non-critical */ }
}

async function updateHeartbeat(
  status: 'running' | 'idle' | 'error',
  details?: string,
): Promise<void> {
  try {
    await db.collection('system').doc('engine_status').set(
      {
        lastRunAt:  new Date().toISOString(),
        status,
        details:    details || '',
        source:     'github-cron',
        updatedAt:  new Date().toISOString(),
      },
      { merge: true },
    );
  } catch { /* non-critical */ }
}

async function recoverStuckTasks(): Promise<number> {
  let recovered = 0;
  const now = Date.now();

  for (const col of queueCollections) {
    try {
      const snap = await db.collection(col).where('status', '==', 'processing').get();
      for (const doc of snap.docs) {
        const data     = doc.data();
        const lockedAt = data.lockedAt || data.updatedAt || data.createdAt || data.addedAt;
        const lockedMs = lockedAt ? now - new Date(lockedAt).getTime() : Infinity;

        if (lockedMs > STUCK_TASK_THRESHOLD_MS) {
          const retryCount = (data.retryCount || 0) + 1;
          if (retryCount > MAX_CRON_RETRIES) {
            await doc.ref.update({
              status:   'failed',
              error:    `Max retries exceeded ${MAX_CRON_RETRIES}/${MAX_CRON_RETRIES}`,
              failedAt: new Date().toISOString(),
            });
          } else {
            await doc.ref.update({
              status:          'pending',
              lockedAt:        null,
              retryCount,
              lastRecoveredAt: new Date().toISOString(),
            });
          }
          recovered++;
        }
      }
    } catch { /* continue */ }
  }

  try {
    const snap = await db.collection('scraping_tasks').where('status', '==', 'processing').get();
    for (const doc of snap.docs) {
      const data      = doc.data();
      const startedAt = data.processingStartedAt || data.createdAt;
      const ageMs     = startedAt ? now - new Date(startedAt).getTime() : 0;

      if (ageMs > STUCK_TASK_THRESHOLD_MS) {
        const links: any[] = data.links || [];
        const TERMINAL = ['done', 'success', 'error', 'failed'];
        const allTerminal = links.length > 0 && links.every(
          (l: any) => TERMINAL.includes((l.status || '').toLowerCase())
        );
        const allSuccess = allTerminal && links.every(
          (l: any) => ['done', 'success'].includes((l.status || '').toLowerCase())
        );

        if (allTerminal) {
          await doc.ref.update({
            status: allSuccess ? 'completed' : 'failed',
            ...(allSuccess ? { completedAt: new Date().toISOString() } : {}),
            recoveredAt: new Date().toISOString(),
          });
          recovered++;
        } else {
          const resetLinks = links.map((l: any) =>
            (!l.status || ['pending', 'processing', ''].includes(l.status))
              ? { ...l, status: 'error', error: 'Task stuck >10min',
                  logs: [...(l.logs || []), { msg: '🔄 Auto-recovered (stuck >10min)', type: 'warn' }] }
              : l,
          );
          await doc.ref.update({
            links: resetLinks,
            status: 'failed',
            recoveredAt: new Date().toISOString(),
            recoveryReason: `Stuck ${Math.round(ageMs / 60000)}min`,
          });
          recovered++;
        }
      }
    }
  } catch { /* continue */ }

  return recovered;
}

const TERMINAL = ['done', 'success', 'error', 'failed'];

async function getActiveTask(): Promise<{ taskId: string; links: any[] } | null> {
  try {
    const snap = await db.collection('scraping_tasks')
      .where('status', '==', 'processing')
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get();

    if (snap.empty) return null;

    const doc  = snap.docs[0];
    const data = doc.data();
    const links: any[] = data.links || [];

    const pendingLinks = links.filter(
      (l: any) => !TERMINAL.includes((l.status || '').toLowerCase())
    );

    if (pendingLinks.length === 0) {
      const allSuccess = links.every(
        (l: any) => ['done', 'success'].includes((l.status || '').toLowerCase())
      );
      await doc.ref.update({
        status: allSuccess ? 'completed' : 'failed',
        completedAt: new Date().toISOString(),
      });

      for (const col of queueCollections) {
        const qSnap = await db.collection(col)
          .where('taskId', '==', doc.id)
          .where('status', '==', 'processing')
          .limit(1)
          .get();
        if (!qSnap.empty) {
          await qSnap.docs[0].ref.update({
            status: 'completed',
            processedAt: new Date().toISOString(),
          });
        }
      }

      return null;
    }

    return { taskId: doc.id, links };
  } catch (e: any) {
    console.error('[Cron] getActiveTask error:', e.message);
    return null;
  }
}

// 🔴 THE FIX: STRICT SEQUENTIAL (Ek baar mein sirf 1 link ka wait karenge)
async function processPendingLinks(
  taskId: string,
  links: any[],
  req: NextRequest,
): Promise<{ triggeredRelay: boolean; stillPending: number; doneLinks: number; totalLinks: number }> {
  
  const pendingLinks = links.filter(
    (l: any) => !TERMINAL.includes((l.status || '').toLowerCase())
  );

  console.log(`[Cron] Task ${taskId}: ${pendingLinks.length} total pending links. Picking ONLY 1 to process and wait.`);

  let triggeredRelay = false;

  // RULE: Pick ONLY the FIRST pending link
  if (pendingLinks.length > 0) {
    const targetLink = pendingLinks[0];

    try {
        // 'Await' lagaya hai. Matlab Vercel yahan ruka rahega jab tak yeh ek quality puri nahi nikal jati.
        console.log(`[Cron] Processing link ${targetLink.id} and waiting for completion...`);
        await processLink(targetLink, targetLink.id, taskId, 'Server/Auto-Pilot');
        console.log(`[Cron] Link ${targetLink.id} processed successfully.`);
    } catch (e) {
        console.error(`[Process Error on link ${targetLink.id}]`, e);
    }
  }

  // Ab DB se fresh data lo, kyunki pehla link process ho chuka hai.
  const freshSnap  = await db.collection('scraping_tasks').doc(taskId).get();
  const freshLinks: any[] = freshSnap.data()?.links || [];
  const stillPending = freshLinks.filter(
    (l: any) => !TERMINAL.includes((l.status || '').toLowerCase())
  ).length;
  const doneLinks = freshLinks.filter(
    (l: any) => ['done', 'success'].includes((l.status || '').toLowerCase())
  ).length;

  // Agar sare links khatam ho gaye, toh Task complete mark kardo.
  if (stillPending === 0) {
    const allSuccess = freshLinks.every(
      (l: any) => ['done', 'success'].includes((l.status || '').toLowerCase())
    );
    await db.collection('scraping_tasks').doc(taskId).update({
      status: allSuccess ? 'completed' : 'failed',
      completedAt: new Date().toISOString(),
    });

    for (const col of queueCollections) {
      const qSnap = await db.collection(col)
        .where('taskId', '==', taskId)
        .where('status', '==', 'processing')
        .limit(1)
        .get();
      if (!qSnap.empty) {
        await qSnap.docs[0].ref.update({
          status: 'completed',
          processedAt: new Date().toISOString(),
        });
      }
    }
  }

  return { triggeredRelay, stillPending, doneLinks, totalLinks: freshLinks.length };
}

export async function GET(req: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET || 'MflixProSecret123';
  const authHeader = req.headers.get('Authorization') || '';

  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const overallStart = Date.now();

  try {
    await updateHeartbeat('running', 'Cron started');

    const recovered = await recoverStuckTasks();
    if (recovered > 0) {
      await sendTelegram(`🔧 Auto-Recovery\n♻️ ${recovered} stuck task(s) recovered`);
    }

    const activeTask = await getActiveTask();

    if (activeTask) {
      const result = await processPendingLinks(activeTask.taskId, activeTask.links, req);
      try { await cleanupExpiredCache(); } catch { /* */ }
      const elapsed = Math.round((Date.now() - overallStart) / 1000);

      if (result.stillPending === 0 && !result.triggeredRelay) {
        await sendTelegram(`✅ Movie Complete 🎬\n🔗 ${result.doneLinks}/${result.totalLinks} done\n⏱ ${elapsed}s`);
        await updateHeartbeat('idle', 'Movie complete — ready for next');
      } else {
        await updateHeartbeat('idle', `Continuing — ${result.stillPending}/${result.totalLinks} pending`);
      }

      return NextResponse.json({
        status: 'continued',
        taskId: activeTask.taskId,
        stillPending: result.stillPending,
        doneLinks: result.doneLinks,
        totalLinks: result.totalLinks,
        recovered,
        elapsed,
      });
    }

    let item: any = null;
    let queueCollection = '';

    for (const col of queueCollections) {
      // 🔴 FIX: orderBy('addedAt') use kiya kyunki aapka data addedAt use karta hai
      const snap = await db
        .collection(col)
        .where('status', '==', 'pending')
        .orderBy('addedAt', 'asc') 
        .limit(1)
        .get();

      if (!snap.empty) {
        const doc = snap.docs[0];
        item = { id: doc.id, ...doc.data() };
        queueCollection = col;
        break;
      }
    }

    if (!item) {
      await updateHeartbeat('idle', 'Queue empty');
      return NextResponse.json({ status: 'idle', message: 'Queue empty', recovered });
    }

    await db.collection(queueCollection).doc(item.id).update({
      status:     'processing',
      lockedAt:   new Date().toISOString(),
      retryCount: item.retryCount || 0,
    });

    let listResult: any;
    try {
      listResult = await extractMovieLinks(item.url);
      if (listResult.status !== 'success' || !listResult.links?.length) {
        throw new Error(listResult.message || 'Link extraction failed');
      }
    } catch (extractionError: any) {
      const currentRetries = item.retryCount || 0;
      const isFinalFail = currentRetries >= MAX_CRON_RETRIES;
      await db.collection(queueCollection).doc(item.id).update({
        status: isFinalFail ? 'failed' : 'pending',
        error: `Extraction failed: ${extractionError.message}`,
        failedAt: isFinalFail ? new Date().toISOString() : null,
        lockedAt: null,
        retryCount: currentRetries + 1,
      });
      throw extractionError;
    }

    const linksWithIds = listResult.links.map((l: any, i: number) => ({
      ...l,
      id:     i,
      status: 'pending',
      logs:   [],
    }));

    const taskRef = await db.collection('scraping_tasks').add({
      url:         item.url,
      status:      'processing',
      createdAt:   new Date().toISOString(),
      extractedBy: 'Server/Auto-Pilot',
      metadata:    listResult.metadata || null,
      preview:     listResult.preview  || null,
      links:       linksWithIds,
    });
    const taskId = taskRef.id;

    await db.collection(queueCollection).doc(item.id).update({ taskId });

    const result = await processPendingLinks(taskId, linksWithIds, req);
    try { await cleanupExpiredCache(); } catch { /* */ }
    const elapsed = Math.round((Date.now() - overallStart) / 1000);
    const title   = listResult.metadata?.title || item.url;

    if (result.stillPending === 0 && !result.triggeredRelay) {
      await updateHeartbeat('idle', 'Complete');
      await sendTelegram(`✅ Auto-Pilot Complete 🤖\n🎬 ${title}\n⏱ ${elapsed}s`);
    } else {
      await updateHeartbeat('idle', `Processing ${title}`);
    }

    return NextResponse.json({
      status: result.stillPending > 0 ? 'in-progress' : 'ok',
      taskId,
      recovered,
      stillPending: result.stillPending,
      elapsed,
    });
  } catch (err: any) {
    await updateHeartbeat('error', err.message);
    await sendTelegram(`🚨 Cron Error\n${err.message}`);
    return NextResponse.json({ status: 'error', error: err.message });
  }
}
