const RETRYABLE_REPLACE_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

export function replaceFileSync(source, target, {
  rename,
  attempts = 16,
  wait = sleepSync,
} = {}) {
  if (typeof rename !== "function") throw new Error("replaceFileSync requires a rename function");
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, target);
      return;
    } catch (error) {
      if (!RETRYABLE_REPLACE_ERRORS.has(error?.code) || attempt >= attempts - 1) throw error;
      wait(Math.min(500, 10 * (2 ** attempt)));
    }
  }
}
