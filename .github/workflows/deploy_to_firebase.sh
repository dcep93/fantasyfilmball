#!/bin/bash

set -euo pipefail

repo_root="$(pwd)"
SA_KEY="${1:-}"

# set -e
# gcloud services enable firebase.googleapis.com firebasedatabase.googleapis.com identitytoolkit.googleapis.com
# firebase projects:addfirebase $GOOGLE_CLOUD_PROJECT
# firebase init hosting --project "$GOOGLE_CLOUD_PROJECT"
# firebase init database --project "$GOOGLE_CLOUD_PROJECT"
# firebase database:instances:create "${GOOGLE_CLOUD_PROJECT}-default-rtdb" --location us-central1 --project "$GOOGLE_CLOUD_PROJECT"
# firebase target:apply database default "${GOOGLE_CLOUD_PROJECT}-default-rtdb" --project "$GOOGLE_CLOUD_PROJECT"
# # Google Auth: simplest is Firebase Console > Authentication > Sign-in method > Google > Enable.
# # REST setup requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from a Web OAuth client.
# access_token="$(gcloud auth print-access-token)"
# curl -sS -X POST -H "Authorization: Bearer $access_token" -H "Content-Type: application/json" "https://identitytoolkit.googleapis.com/v2/projects/$GOOGLE_CLOUD_PROJECT/identityPlatform:initializeAuth" -d "{}" || true
# curl -sS -X POST -H "Authorization: Bearer $access_token" -H "Content-Type: application/json" "https://identitytoolkit.googleapis.com/admin/v2/projects/$GOOGLE_CLOUD_PROJECT/defaultSupportedIdpConfigs?idpId=google.com" -d "{\"enabled\":true,\"clientId\":\"$GOOGLE_OAUTH_CLIENT_ID\",\"clientSecret\":\"$GOOGLE_OAUTH_CLIENT_SECRET\"}" || true
# curl -sS -X PATCH -H "Authorization: Bearer $access_token" -H "Content-Type: application/json" "https://identitytoolkit.googleapis.com/admin/v2/projects/$GOOGLE_CLOUD_PROJECT/defaultSupportedIdpConfigs/google.com?updateMask=enabled,clientId,clientSecret" -d "{\"enabled\":true,\"clientId\":\"$GOOGLE_OAUTH_CLIENT_ID\",\"clientSecret\":\"$GOOGLE_OAUTH_CLIENT_SECRET\"}" || true
# gcloud iam service-accounts create deployer-github
# sleep 1
# gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:deployer-github@$GOOGLE_CLOUD_PROJECT.iam.gserviceaccount.com" --role="roles/firebasehosting.admin"
# gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:deployer-github@$GOOGLE_CLOUD_PROJECT.iam.gserviceaccount.com" --role="roles/firebase.admin"
# gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:deployer-github@$GOOGLE_CLOUD_PROJECT.iam.gserviceaccount.com" --role="roles/serviceusage.serviceUsageAdmin"
# gcloud iam service-accounts keys create gac.json --iam-account "deployer-github@$GOOGLE_CLOUD_PROJECT.iam.gserviceaccount.com"
# echo
# echo
# echo
# cat gac.json
# echo
# echo
# echo

if [[ -z "$SA_KEY" ]]; then
	if [[ ! -f "$repo_root/SA_KEY.json" ]]; then
		echo "Expected service account JSON as arg 1 or at $repo_root/SA_KEY.json" >&2
		exit 1
	fi

	SA_KEY="$(cat "$repo_root/SA_KEY.json")"
fi

cd app

export GOOGLE_APPLICATION_CREDENTIALS="gac.json"
echo "$SA_KEY" >"$GOOGLE_APPLICATION_CREDENTIALS"
npm install -g firebase-tools
gcloud auth activate-service-account --key-file="$GOOGLE_APPLICATION_CREDENTIALS"
project_id="$(jq -r .project_id "$GOOGLE_APPLICATION_CREDENTIALS")"

if [[ "$project_id" != "fantasyfilmball" ]]; then
	echo "Expected SA key for project fantasyfilmball, got $project_id" >&2
	exit 1
fi

cat <<EOF2 >firebase.json
{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [{
      "source": "**",
      "destination": "/index.html"
    }]
  },
  "database": [{
    "target": "default",
    "rules": "database.rules.json"
  }]
}
EOF2

cat <<EOF2 >.firebaserc
{
  "projects": {
    "default": "$project_id"
  },
  "targets": {
    "$project_id": {
      "database": {
        "default": [
          "$project_id-default-rtdb"
        ]
      }
    }
  }
}
EOF2

firebase deploy --project "$project_id"
