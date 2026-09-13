import appWorker from "../dist/server/index.js";

function isNextStaticAsset(request) {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith("/_next/static/");
}

const pagesWorker = {
  async fetch(request, env, ctx) {
    // A Pages advanced-mode worker owns every request. Vinext's server handles
    // application routes, while Pages' asset binding must serve the emitted
    // CSS and browser bundles below /_next/static/.
    if (isNextStaticAsset(request) && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return appWorker.fetch(request, env, ctx);
  },
};

export default pagesWorker;
