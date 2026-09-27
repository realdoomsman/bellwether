/** Check list + final verdict shared by the fork proofs. */
const STARTED = Date.now();

interface Check {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
let current = '';

export function section(title: string): void {
  current = title;
  console.log(`\n== ${title}`);
}

export function check(name: string, ok: boolean, detail = ''): boolean {
  checks.push({ section: current, name, ok, detail });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}

export function note(line: string): void {
  console.log(`   ${line}`);
}

/** Prints the verdict (`<title> PASSED|FAILED`) and sets the exit code. */
export function report(title: string): void {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed in ${Math.round((Date.now() - STARTED) / 1000)}s`);
  for (const c of failed) console.log(`FAIL [${c.section}] ${c.name}: ${c.detail}`);
  const ok = failed.length === 0 && checks.length > 0;
  console.log(`${title} ${ok ? 'PASSED' : 'FAILED'}`);
  process.exitCode = ok ? 0 : 1;
}

/**
 * Runs a proof's main: an abort prints the error, then the verdict (FAILED). `exit` ends the process after
 * the verdict even if abandoned work (e.g. a timed-out scan) still holds sockets open.
 */
export function run(title: string, main: () => Promise<void>, opts: { exit?: boolean } = {}): void {
  main()
    .catch((err: unknown) => {
      console.error(`\n${title} ABORTED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      check('proof ran to completion', false, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      report(title);
      if (opts.exit) process.exit();
    });
}
