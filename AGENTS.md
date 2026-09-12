# Release policy

- This repository is published at `https://spectra-lab.byte-wizard.chatgpt.site`.
- Reuse the existing `project_id` and slug in `.openai/hosting.json`; do not create a new Site or change the public URL unless the user explicitly requests it.
- After every completed, validated website change, publish the new version to the existing public Site so the stable URL updates in place.
- Mirror each released source revision to the public GitHub repository `https://github.com/liuzhitao-ByteWizard/spectra-ai-lab` on `main`.
- Never commit local environment files, credentials, API keys, deployment tokens, or generated build output.
- Do not publish partially completed or unvalidated worktree changes.
