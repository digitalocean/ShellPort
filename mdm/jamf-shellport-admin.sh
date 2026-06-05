#!/bin/bash
# ShellPort — Jamf Pro install script (macOS, managed DO interview stations).
#
# The installer itself detects it's running as root (Jamf) and re-runs in the
# logged-in user's GUI session, so this script only needs to map Jamf's policy
# parameters to the SHELLPORT_* config the installer reads, then run the one-liner.
#
# Jamf reserves: $1=mount point  $2=computer name  $3=username
# Custom parameters (label these on the script's Options tab):
#   $4  Questions URL      -> SHELLPORT_QUESTIONS   (Google Doc/Sheet link)
#   $5  Slack bot token    -> SHELLPORT_SLACK_TOKEN (xoxb-…, scope chat:write)
#   $6  Slack channel      -> SHELLPORT_SLACK_CHANNEL (#name or C0… id)
#   $7  Machine label      -> SHELLPORT_LABEL       (e.g. DO-Station-07)
#   $8  Project name       -> SHELLPORT_PROJECT
#   $9  Row or tab pin     -> a sheet row number, or t.<tabId> (optional)
#   $10 Version pin        -> INTERVIEW_VERSION     (e.g. v2.1.0; blank = latest)

[ -n "$4" ]    && export SHELLPORT_QUESTIONS="$4"
[ -n "$5" ]    && export SHELLPORT_SLACK_TOKEN="$5"
[ -n "$6" ]    && export SHELLPORT_SLACK_CHANNEL="$6"
[ -n "$7" ]    && export SHELLPORT_LABEL="$7"
[ -n "$8" ]    && export SHELLPORT_PROJECT="$8"
case "$9" in
  t.*)     export SHELLPORT_QUESTION_TAB="$9" ;;
  [0-9]*)  export SHELLPORT_QUESTION_ROW="$9" ;;
esac
[ -n "${10}" ] && export INTERVIEW_VERSION="${10}"

curl -fsSL https://do.co/shellport-admin-mac | bash
exit $?
