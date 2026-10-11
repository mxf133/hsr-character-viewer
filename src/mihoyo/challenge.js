// Retry a record call that answered `1034` (challenge required).
//
// Snap Hutao calls this `RetryIf1034Async`: on 1034 it runs the Geetest flow,
// attaches `x-rpc-challenge`, re-signs and re-sends. The solve step needs a
// browser, so this module exposes the two halves:
//
//   * `runWithChallenge(...)` - attempt a call; if it returns 1034, create a
//     challenge and surface it to the caller so the GUI can ask the user to
//     solve it.
//   * `resumeWithChallenge(...)` - after the user solves it, retry with the
//     obtained `x-rpc-challenge`.
//
// 1034 does not mean "no permission": it means "verify first". Treating it as a
// hard failure is why character data looked unavailable.

import { challengePathFor, createVerification, completeVerification } from './verification.js';

export const isChallengeRequired = (error) => Number(error?.retcode) === 1034;

/**
 * Run `attempt`, and if it answers 1034, start a challenge for the user.
 * @returns {Promise<{ ok:true, value:any } | { ok:false, challenge:object }>}
 */
export const runWithChallenge = async (attempt, context) => {
  try {
    return { ok: true, value: await attempt() };
  } catch (error) {
    if (!isChallengeRequired(error)) throw error;
    const challenge = await createVerification({
      cookie: context.cookie,
      deviceId: context.deviceId,
      challengePath: context.challengePath
        || challengePathFor(context.kind),
      page: context.page,
    });
    return { ok: false, challenge, reason: error.message };
  }
};

/**
 * Retry `attempt` with a solved challenge.
 * @param {{ validate:string, seccode?:string, challenge?:string }} solved
 */
export const resumeWithChallenge = async (challengeId, solved, attempt) => {
  const { challenge } = await completeVerification(challengeId, solved);
  return attempt(challenge);
};
