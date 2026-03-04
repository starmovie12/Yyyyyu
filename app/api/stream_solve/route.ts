import { db } from '@/lib/firebaseAdmin';
import {
  solveHBLinks,
  solveHubCDN,
  solveHubDrive,
  solveHubCloudNative,
  solveGadgetsWebNative,
} from '@/lib/solvers';
import {
  TIMER_API,
  TIMER_DOMAINS,
  TARGET_DOMAINS,
  LINK_TIMEOUT_MS,
  OVERALL_TIMEOUT_MS,
} from '@/lib/config';
import { getCachedLink, setCachedLink } from '@/lib/cache';

export const maxDuration = 60;

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL VPS MUTEX — ONE REQUEST AT A TIME
// HubCloud VPS (port 5001) can only handle ONE request at a time.
// This mutex ensures ALL paths that lead to solveHubCloudNative() are
// queued strictly one after another.
// ═══════════════════════════════════════════════════════════════════════════
let _hubcloudMutex: Promise<void> = Promise.resolve();

async function solveHubCloudSequential(url: string): Promise<ReturnType<typeof solveHubCloudNative>> {
  const result = _hubcloudMutex.then(() => solveHubCloudNative(url));
  _hubcloudMutex = result.then(() => {}, () => {});
  return result;
}

// ─── HELPER: fetchJSON ────────────────────────────────────────────────────
async function fetchJSON(url: string, timeoutMs = LINK_TIMEOUT_MS): Promise<any> {
  const axios = (await import('axios')).default;
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'MflixPro/3.0' },
    });
    return res.data;
  } catch (err: any) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      throw new Error(`Timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

// ─── HELPER: saveToFirestore ──────────────────────────────────────────────
async function saveToFirestore(
  taskId: string | undefined,
  lid: number | string,
  linkData: any,
  result: {
    status?: string;
    finalLink?: string | null;
    error?: string | null;
    logs?: any[];
    best_button_name?: string | null;
    all_available_buttons?: any[];
  },
  extractedBy: string,
): Promise<void> {
  if (!taskId) return;
  try {
    const taskRef = db.collection('scraping_tasks').doc(taskId);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(taskRef);
      if (!doc.exists) return;

      const existing = doc.data()?.links || [];
      const updated = existing.map((l: any) => {
        if (l.id === lid || l.link === linkData.link) {
          return {
            ...l,
            finalLink:             result.finalLink            ?? l.finalLink ?? null,
            status:                result.status               ?? 'error',
            error:                 result.error                ?? null,
            logs:                  result.logs                 ?? [],
            best_button_name:      result.best_button_name     ?? null,
            all_available_buttons: result.all_available_buttons ?? [],
            solvedAt: new Date().toISOString(),
          };
        }
        return l;
      });

      // ── Task status logic ──────────────────────────────────────────────
      // Task is "completed" ONLY if ALL links have finalLink (done/success).
      // Even one failed link = task is "failed", not "completed".
      const allDone = updated.every((l: any) =>
        ['done', 'success', 'error', 'failed'].includes((l.status || '').toLowerCase())
      );
      const allSuccess = updated.every((l: any) =>
        ['done', 'success'].includes((l.status || '').toLowerCase())
      );

      // Status rules:
      // - All links done + all succeeded → completed
      // - All links done + any failed → failed
      // - Still processing → processing
      let taskStatus = 'processing';
      if (allDone) {
        taskStatus = allSuccess ? 'completed' : 'failed';
      }

      tx.update(taskRef, {
        links: updated,
        status: taskStatus,
        extractedBy,
        ...(allDone ? { completedAt: new Date().toISOString() } : {}),
      });
    });
  } catch (e: any) {
    console.error('[Stream] DB save error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/stream_solve — MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const allLinks: any[]   = body?.links || [];
  const taskId: string     = body?.taskId;
  const extractedBy        = body?.extractedBy || 'Browser/Live';
  const retryFailedOnly    = body?.retryFailedOnly === true;
  const singleLinkId       = body?.singleLinkId;

  if (!allLinks.length) {
    return new Response(JSON.stringify({ error: 'No links provided' }), { status: 400 });
  }

  // ─── Filter links based on mode ─────────────────────────────────────
  let linksToProcess: any[];

  if (singleLinkId !== undefined && singleLinkId !== null) {
    linksToProcess = allLinks.filter((l: any) => l.id === singleLinkId);
    if (linksToProcess.length === 0) {
      return new Response(JSON.stringify({ error: 'Link not found' }), { status: 404 });
    }
  } else if (retryFailedOnly) {
    linksToProcess = allLinks.filter((l: any) => {
      const s = (l.status || '').toLowerCase();
      return s !== 'done' && s !== 'success';
    });
    if (linksToProcess.length === 0) {
      return new Response(JSON.stringify({ error: 'No failed/pending links to retry' }), { status: 200 });
    }
  } else {
    linksToProcess = allLinks;
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder      = new TextEncoder();
      const overallStart = Date.now();
      let   linksDone    = 0;

      const send = (data: any) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(data) + '\n')); }
        catch { /* stream closed */ }
      };

      // ═══════════════════════════════════════════════════════════════════
      // processOneLinkWithRetry — Core solver with 1 automatic retry
      // Returns: { status, finalLink?, error?, logs[], best_button_name? }
      // ═══════════════════════════════════════════════════════════════════
      const processOneLinkWithRetry = async (
        linkData: any,
        lid: number | string,
        attempt: number,
      ): Promise<any> => {
        const originalUrl = linkData.link;
        let   currentLink = originalUrl;
        const logs: { msg: string; type: string }[] = [];

        const log = (msg: string, type = 'info') => {
          logs.push({ msg, type });
          send({ id: lid, msg, type });
        };

        // ── Cache check (attempt 1 only) ───────────────────────────────
        if (attempt === 1) {
          try {
            const cached = await getCachedLink(originalUrl);
            if (cached && cached.finalLink) {
              log('⚡ CACHE HIT — resolved in 0ms', 'success');
              const taskRef = db.collection('scraping_tasks').doc(taskId);
              await db.runTransaction(async (tx: any) => {
                const snap = await tx.get(taskRef);
                if (!snap.exists) return;
                const dbLinks = snap.data()!.links || [];
                const idx = dbLinks.findIndex((l: any) => String(l.id) === String(lid));
                if (idx === -1) return;
                dbLinks[idx] = {
                  ...dbLinks[idx],
                  status: 'done',
                  finalLink: cached.finalLink,
                  best_button_name: cached.best_button_name ?? null,
                  all_available_buttons: cached.all_available_buttons ?? [],
                  logs: [{ msg: '⚡ CACHE HIT', type: 'success' }],
                  solvedAt: new Date().toISOString(),
                };
                tx.update(taskRef, { links: dbLinks });
              });
              send({ id: lid, status: 'done', final: cached.finalLink, best_button_name: cached.best_button_name });
              return { status: 'done', finalLink: cached.finalLink, logs };
            }
          } catch { /* cache miss */ }
        }

        try {
          const solving = async () => {
            // HubCDN.fans shortcut
            if (currentLink.includes('hubcdn.fans')) {
              log('⚡ HubCDN.fans detected — direct solve');
              const r = await solveHubCDN(currentLink);
              if (r.status === 'success') return { finalLink: r.final_link, status: 'done', logs };
              return { status: 'error', error: r.message, logs };
            }

            // Timer bypass loop (gadgetsweb etc.)
            let loopCount = 0;
            while (loopCount < 3 && !(TARGET_DOMAINS.some(d => currentLink.includes(d)))) {
              if (!TIMER_DOMAINS.some(d => currentLink.includes(d)) && loopCount === 0) break;

              if (currentLink.includes('gadgetsweb')) {
                log(`🔁 GadgetsWeb native solve (loop ${loopCount + 1})`);
                const r = await solveGadgetsWebNative(currentLink);
                if (r.status === 'success' && r.link) { currentLink = r.link; loopCount++; continue; }
                log(`❌ GadgetsWeb failed: ${r.message}`, 'error');
                break;
              } else {
                log(`⏱ Timer bypass via VPS (loop ${loopCount + 1})`);
                const r = await fetchJSON(
                  `${TIMER_API}/solve?url=${encodeURIComponent(currentLink)}`,
                  LINK_TIMEOUT_MS,
                );
                if (r.status === 'success' && r.extracted_link) { currentLink = r.extracted_link; loopCount++; continue; }
                log('❌ Timer bypass failed', 'error');
                break;
              }
            }

            // HBLinks
            if (currentLink.includes('hblinks')) {
              log('🔗 HBLinks solving...');
              const r = await solveHBLinks(currentLink);
              if (r.status === 'success' && r.link) {
                currentLink = r.link;
                log(`✅ HBLinks → ${r.source || 'resolved'}`);
              } else return { status: 'error', error: r.message, logs };
            }

            // HubDrive
            if (currentLink.includes('hubdrive')) {
              log('💾 HubDrive solving...');
              const r = await solveHubDrive(currentLink);
              if (r.status === 'success' && r.link) {
                currentLink = r.link;
                log('✅ HubDrive → resolved');
              } else return { status: 'error', error: r.message, logs };
            }

            // HubCloud / HubCDN — mutex ensures only 1 at a time
            if (currentLink.includes('hubcloud') || currentLink.includes('hubcdn')) {
              log(`☁️ HubCloud VPS call: ${currentLink}`);
              try {
                const r = await solveHubCloudSequential(currentLink);
                if (r.status === 'success' && r.best_download_link) {
                  log(`✅ HubCloud done: ${r.best_download_link}`, 'success');
                  return {
                    finalLink:             r.best_download_link,
                    status:                'done',
                    best_button_name:      r.best_button_name      ?? null,
                    all_available_buttons: r.all_available_buttons ?? [],
                    logs,
                  };
                }
                const errDetail = r.message || 'No download link in response';
                log(`❌ HubCloud failed: ${errDetail}`, 'error');
                return { status: 'error', error: errDetail, logs };
              } catch (hubErr: any) {
                const errMsg = hubErr?.message || String(hubErr);
                log(`❌ HubCloud exception: ${errMsg}`, 'error');
                return { status: 'error', error: errMsg, logs };
              }
            }

            // GDflix / DriveHub
            if (currentLink.includes('gdflix') || currentLink.includes('drivehub')) {
              log(`✅ Resolved: ${currentLink}`, 'success');
              return { finalLink: currentLink, status: 'done', logs };
            }

            // Fallback
            if (currentLink !== originalUrl) {
              log(`✅ Resolved: ${currentLink}`, 'success');
              return { finalLink: currentLink, status: 'done', logs };
            }

            return { status: 'error', error: 'No solver matched', logs };
          };

          return await Promise.race([
            solving(),
            new Promise<any>((_, rej) =>
              setTimeout(() => rej(new Error(`Timeout ${LINK_TIMEOUT_MS / 1000}s`)), LINK_TIMEOUT_MS),
            ),
          ]);

        } catch (err: any) {
          return { status: 'error', error: err.message, logs };
        }
      };

      // ═══════════════════════════════════════════════════════════════════
      // processLink — Wraps processOneLinkWithRetry with 1 auto-retry
      // If attempt 1 fails → wait 2s → try again → then give up
      // ═══════════════════════════════════════════════════════════════════
      const processLink = async (linkData: any, lid: number | string, linkNum: number, total: number): Promise<void> => {
        send({ id: lid, msg: `🔄 Link ${linkNum}/${total} — starting...`, type: 'info' });

        // Attempt 1
        let result = await processOneLinkWithRetry(linkData, lid, 1);

        // Auto-retry once if failed
        if (result.status === 'error' || result.status === 'failed') {
          send({ id: lid, msg: `🔁 Auto-retry (attempt 2)...`, type: 'warn' });
          await new Promise(r => setTimeout(r, 2000)); // 2s wait before retry
          result = await processOneLinkWithRetry(linkData, lid, 2);
        }

        // Stream final result
        send({
          id:               lid,
          status:           result.status,
          final:            result.finalLink,
          best_button_name: result.best_button_name,
        });

        // Save to Firestore
        try {
          await saveToFirestore(taskId, lid, linkData, result, extractedBy);
        } catch { /* non-fatal */ }

        // Cache successful result
        if (result.status === 'done' && result.finalLink) {
          try {
            await setCachedLink(linkData.link, result.finalLink, 'stream_solve', {
              best_button_name: result.best_button_name,
              all_available_buttons: result.all_available_buttons,
            });
          } catch { /* non-critical */ }
        }

        send({ id: lid, status: 'finished' });
        linksDone++;
      };

      // ═══════════════════════════════════════════════════════════════════
      // MAIN EXECUTION: ALL LINKS → STRICTLY ONE BY ONE (sequential)
      // No parallel processing at all — VPS can't handle concurrent calls.
      // Ek link complete → next link start.
      // ═══════════════════════════════════════════════════════════════════
      const total = linksToProcess.length;

      for (let i = 0; i < total; i++) {
        const link = linksToProcess[i];

        // Time budget check
        if (Date.now() - overallStart > OVERALL_TIMEOUT_MS) {
          send({ id: link.id, msg: '⏳ Time budget exceeded — will retry in background', type: 'warn' });
          send({ id: link.id, status: 'finished' });
          continue;
        }

        await processLink(link, link.id, i + 1, total);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}
