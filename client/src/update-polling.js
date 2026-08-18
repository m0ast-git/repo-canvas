export const UPDATE_POLL_ACTIVE_MS = 750;
export const UPDATE_POLL_IDLE_MS = 60 * 60 * 1000;

export function updatePollDelay(status) {
  return status === "applying" ? UPDATE_POLL_ACTIVE_MS : UPDATE_POLL_IDLE_MS;
}

export function updateFinished(previousStatus, nextStatus) {
  return previousStatus === "applying" && ["current", "updated"].includes(nextStatus);
}
