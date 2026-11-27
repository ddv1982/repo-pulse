import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startApp } from './server/runtime.ts';
import { canOpenBrowser, openBrowser } from './server/open-browser.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // No fixed port by default: a new origin every run means nothing another account served earlier on that port, such as a
  // service worker, applies to this run.
  const port = Number(process.env.PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const runtime = await startApp({
    demo: process.argv.includes('--demo'),
    port,
    dataDir: process.env.REPO_PULSE_DATA_DIR || undefined,
  }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code !== 'DATA_DIR_LOCKED') throw error;
    console.error((error as Error).message);
    return process.exit(1);
  });
  console.log(`Repo Pulse${process.argv.includes('--demo') ? ' · demo data, no Azure calls' : ''}: ${runtime.launchUrl}`);
  const open = process.env.REPO_PULSE_NO_BROWSER !== '1' && canOpenBrowser(process.platform, process.env);
  console.log(
    `${open ? 'Opening it in your browser; if the browser does not show Repo Pulse, use the link above.' : 'Open the link above in your browser.'} It works once and a new one is printed at every start. Local only. Stop with Ctrl+C.`,
  );
  const removeLaunchPage = open ? await openBrowser(runtime.launchUrl, { dataDir: runtime.dataDir }) : async () => {};
  let closing = false;
  const stop = async () => {
    if (!closing) {
      closing = true;
      await removeLaunchPage().catch(() => {});
      await runtime.close();
    }
  };
  // A failed close reaches Node's unhandled-rejection handling, which prints it and exits with code 1.
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
