# Test Scripts

## Fetch a Single Page (Blackbaud)

Test fetching a specific page from the Blackbaud Advance list using the same tools and methods as the poller.

```bash
# Fetch page 100 (default) - run from project root
npm run test:fetch-page

# Fetch a specific page (use -- before args so npm passes them to the script)
npm run test:fetch-page -- --page 62
npm run test:fetch-page -- --page=50

# Via env
TEST_PAGE=25 npm run test:fetch-page
```

## Fetch Candidate Checklist (AFE-EDEMS)

Test fetching a specific candidate's checklist:

```bash
npm run test:fetch-candidate -- --candidate 1234 --year "2024 - 2025"
```

Requires `.env` with Blackbaud credentials and a valid refresh token (`npm run bb:auth`).
