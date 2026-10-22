/** Stable data survives long absences; disk capacity limits remain independent. */
export const CACHE_YEAR_HOURS = 365 * 24;
export const MOUNT_FILE_CACHE_MIB = 8192;
export const SHARED_READ_CACHE_MIB = 16384;
export const directoryCacheDefault = (kind: 'local' | 'remote') => (kind === 'local' ? 365 : 30) * 24 * 60 * 60;
