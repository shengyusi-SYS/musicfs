// The pinned SDK ships ESM implementation and CJS-tree declarations separately.
// build:qq generates the matching ESM export entry; no dependency source is modified.
export { createSealedSessionResolver } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/serverless/sealedResolver.js';
export { deriveAndroidDevice } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/serverless/derivedDevice.js';
export { createSessionMusicuClient } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/recommend/sessionMusicu.js';
export { AUTH_REFRESH_EARLY_MS, AUTH_REFRESH_RETRY_MS } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/auth/sessionState.js';
export { createFetchTransport } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/transport/fetch.js';
export { refreshLoginCredential } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/auth/authenticatedReads.js';
export type { AuthHttpClient } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/auth/httpClient.js';
export { credentialMusicId } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/auth/androidDevice.js';
export { QqApiError } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/protocol/errors.js';
export { StreamCdnSelector } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/auth/streamCdnSelector.js';
export { apeFileFailureOf } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/protocol/qualityFile.js';
export { MUSIC_FILE_TYPES } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/auth/playback.js';
export { DAILY_SONGS } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/recommend/dailySongs.js';
export { recommendPlaylistsResult } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/recommend/recommendPlaylists.js';
export type { AuthSession } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/services/auth/qrTypes.js';
export type { MusicuDescriptor } from './node_modules/@yakult-green-tea/qq-music-api/dist/src/protocol/musicu.js';
