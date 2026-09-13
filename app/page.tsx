import SpectraApp from "./SpectraApp";
import { getAuthenticationAction, getSiteUser } from "./site-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getSiteUser();
  const authenticationAction = getAuthenticationAction(user);
  return <SpectraApp
    authenticated={Boolean(user)}
    viewerName={user?.fullName ?? user?.email ?? null}
    authHref={authenticationAction.href}
    authLabel={authenticationAction.label}
  />;
}
