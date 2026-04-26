export async function loadRemoteSkill(
  slug: string,
  _url: string,
): Promise<never> {
  throw new Error(
    `Remote skill loading is not available in this restored build (${slug})`,
  )
}
