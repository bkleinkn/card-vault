# Grant the Card Vault Cloud Functions runtime service account the Firestore +
# Storage access it needs.
#
# Why: this project is parented under the bkleinkn-org GCP organization, so its
# default Compute Engine service account (used by 2nd-gen functions) was never
# granted Firestore/Storage access. Until you run this, three features stay
# inert and degrade gracefully:
#   - public share links (createShareLink / getSharedCollection)
#   - image cleanup when a card is deleted (onCardDeleted)
#   - "Identify with AI" retry on a saved card (identifyStored)
# (Scanning, the pending-review pool, hand-editing, and the collection all work
#  without this — the daily-quota counter is also inert until it's granted.)
#
# Run once, from any machine where `gcloud` is authenticated as a project
# Owner / IAM admin:
#   powershell -File scripts/grant-iam.ps1
# Takes effect within ~1 minute. No function redeploy needed.

$ErrorActionPreference = "Stop"

$PROJECT = "card-vault-d8fa4"
# 2nd-gen functions run as the default Compute Engine service account.
# (project number 1007054529380 — see public/app.js firebaseConfig.)
$SA = "1007054529380-compute@developer.gserviceaccount.com"

Write-Host "Granting Firestore + Storage access to $SA ..."

gcloud projects add-iam-policy-binding $PROJECT `
  --member="serviceAccount:$SA" `
  --role="roles/datastore.user"

gcloud projects add-iam-policy-binding $PROJECT `
  --member="serviceAccount:$SA" `
  --role="roles/storage.objectAdmin"

Write-Host ""
Write-Host "Done. Share links, delete-cleanup, and 'Identify with AI' will work within ~1 minute."
