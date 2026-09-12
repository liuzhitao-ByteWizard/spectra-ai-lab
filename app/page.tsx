import SpectraApp from "./SpectraApp";
import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return <SpectraApp
    authenticated={Boolean(user)}
    viewerName={user?.fullName ?? user?.email ?? null}
    authHref={user ? chatGPTSignOutPath("/") : chatGPTSignInPath("/")}
    authLabel={user ? "退出登录" : "登录并保存记录"}
  />;
}
