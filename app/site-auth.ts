import { headers } from "next/headers";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
  type ChatGPTUser,
} from "./chatgpt-auth";

export type SiteUser = ChatGPTUser & {
  provider: "cloudflare-access" | "chatgpt";
};

export type AuthenticationAction = {
  href: string | null;
  label: string;
};

const CLOUDFLARE_ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

/**
 * Prefer the verified identity supplied by Cloudflare Access. The legacy
 * ChatGPT identity remains as a temporary compatibility path for the current
 * Sites deployment while the Cloudflare Pages release is brought online.
 */
export async function getSiteUser(): Promise<SiteUser | null> {
  const requestHeaders = await headers();
  const accessEmail = normalizeEmail(
    requestHeaders.get(CLOUDFLARE_ACCESS_EMAIL_HEADER),
  );

  if (accessEmail) {
    return {
      userId: `email:${accessEmail}`,
      displayName: accessEmail,
      email: accessEmail,
      fullName: null,
      provider: "cloudflare-access",
    };
  }

  const chatGPTUser = await getChatGPTUser();
  return chatGPTUser ? { ...chatGPTUser, provider: "chatgpt" } : null;
}

export function getAuthenticationAction(
  user: SiteUser | null,
): AuthenticationAction {
  if (user?.provider === "cloudflare-access") {
    return { href: null, label: "邮箱已验证" };
  }

  return user
    ? { href: chatGPTSignOutPath("/"), label: "退出登录" }
    : { href: chatGPTSignInPath("/"), label: "登录并保存记录" };
}

function normalizeEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  if (
    !email ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }
  return email;
}
