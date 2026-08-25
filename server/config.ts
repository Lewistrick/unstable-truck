/** Who may read the run log, from ADMIN_USERNAMES (comma-separated).
 *
 * Unset is deliberately different from empty: unset means "not configured
 * here", and leaves whatever is in the database alone, so a deploy that forgets
 * the variable doesn't silently strip everyone's rights. Set-but-empty means
 * "nobody", and is honoured. */
export function configuredAdmins(): string[] | null {
  const raw = process.env.ADMIN_USERNAMES;
  if (raw === undefined) return null;
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
