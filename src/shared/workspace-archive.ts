/**
 * The most workspace IDs one `workspace.archiveMany` request accepts. The
 * client splits a larger selection into requests of this size.
 */
export const ARCHIVE_MANY_MAX_IDS = 100;
