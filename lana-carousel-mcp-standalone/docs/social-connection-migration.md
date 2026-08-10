# Social account connection migration

This branch replaces the public Facebook Login dependency in Social Publisher with a narrower internal-account model.

## Contract

- Facebook Page is provisioned by server environment only. The Page access token is never returned to the browser and remains encrypted at rest in `social_accounts`.
- Instagram connects independently through Instagram Login using only `instagram_business_basic` and `instagram_business_content_publish`.
- TikTok OAuth is unchanged.
- Existing publish queue, media snapshots, retry semantics and delivery history are unchanged.

This file is part of the test-first migration checkpoint and will be folded into `docs/social-publishing.md` once implementation is green.
