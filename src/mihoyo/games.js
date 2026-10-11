// Star Rail record client and its public configuration descriptor.

import { GAMES } from './constants.js';
import * as hsr from './starrail.js';

/** Star Rail descriptor for the GUI (safe to serialise). */
export const gameDescriptors = () => Object.values(GAMES).map((g) => ({
  key: g.key,
  label: g.label,
  shortLabel: g.shortLabel,
  gameBiz: g.gameBiz,
  gameId: g.gameId,
  regions: g.regions,
  available: true,
}));

export const enabledGameDescriptors = gameDescriptors;
export const supportedGameKeys = () => ['hsr'];

/** Fetch a full, GUI-ready snapshot for one Star Rail role. */
export const fetchSnapshot = (uid, server, options = {}) =>
  hsr.getFullSnapshot(uid, server, options);

/** Visibility switches and the record card are global (per account), not per game. */
export { getGameRecordCard, getPrivacySwitches, setPrivacySwitch } from './starrail.js';

export { GAMES };
