// Confirms computeVisibility derives flags purely from BPF helpers + product
// type (no group routing). Mirrors App.tsx. Throwaway.
const PT = '_usgs_producttype_value'
const H = {
  peerReviewSkipped: 'usgs_bpfhelperpeerreviewskipped',
  baoApprovalSkipped: 'usgs_bpfhelperbaoapprovalskipped',
  spnSkipped: 'usgs_bpfhelperspnskipped',
  notOpenAccessJournalArticle: 'usgs_bpfhelpernotopenaccessjournalarticle',
}
const SPN = new Set(['usgs series publication', 'nonseries usgs publications', 'circular'])
const DIRECT = new Set(['extramural-authored publication'])
function readLabel(r, n) { return String(r[`${n}@OData.Community.Display.V1.FormattedValue`] ?? r[n] ?? '') }
function isTruthy(v) { return v === true || v === 1 || v === '1' || /^(true|yes)$/i.test(String(v ?? '')) }
function isSpn(l) { return SPN.has(l.trim().toLowerCase()) }
function isDirect(l) { return DIRECT.has(l.trim().toLowerCase()) }
function computeVisibility(r) {
  const l = readLabel(r, PT)
  return {
    showPeerReview: !isTruthy(r[H.peerReviewSkipped]),
    showBaoApproval: !isTruthy(r[H.baoApprovalSkipped]),
    showSpnStages: !isTruthy(r[H.spnSkipped]) && isSpn(l),
    showAcceptedManuscript: isTruthy(r[H.notOpenAccessJournalArticle]),
    directDisseminationOnly: isDirect(l),
  }
}
const rec = (pt, h = {}) => ({ [`${PT}@OData.Community.Display.V1.FormattedValue`]: pt, ...h })
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const cases = [
  // Abstract, everything skipped -> all optional off.
  ['abstract all-skipped', rec('Abstract or Summary', { [H.peerReviewSkipped]: true, [H.baoApprovalSkipped]: true, [H.spnSkipped]: true }),
    { showPeerReview: false, showBaoApproval: false, showSpnStages: false, showAcceptedManuscript: false, directDisseminationOnly: false }],
  // Peer review not skipped -> shown. BAO not skipped -> shown.
  ['peer + bao shown', rec('Atlas', { [H.peerReviewSkipped]: false, [H.baoApprovalSkipped]: false }),
    { showPeerReview: true, showBaoApproval: true, showSpnStages: false, showAcceptedManuscript: false, directDisseminationOnly: false }],
  // SPN: spnSkipped=false AND USGS series -> SPN shown.
  ['usgs series + spn not skipped', rec('USGS Series Publication', { [H.spnSkipped]: false }),
    { showPeerReview: true, showBaoApproval: true, showSpnStages: true, showAcceptedManuscript: false, directDisseminationOnly: false }],
  // SPN: spnSkipped=true even on USGS series -> SPN hidden.
  ['usgs series + spn skipped', rec('USGS Series Publication', { [H.spnSkipped]: true }),
    { showPeerReview: true, showBaoApproval: true, showSpnStages: false, showAcceptedManuscript: false, directDisseminationOnly: false }],
  // SPN gate: spnSkipped=false but NOT an SPN product type -> SPN hidden.
  ['non-spn type + spn not skipped', rec('Atlas', { [H.spnSkipped]: false }),
    { showPeerReview: true, showBaoApproval: true, showSpnStages: false, showAcceptedManuscript: false, directDisseminationOnly: false }],
  // Accepted manuscript: notOpenAccessJournalArticle=true -> shown.
  ['accepted manuscript', rec('Journal or Periodical Article', { [H.notOpenAccessJournalArticle]: true }),
    { showPeerReview: true, showBaoApproval: true, showSpnStages: false, showAcceptedManuscript: true, directDisseminationOnly: false }],
  // Extramural -> direct dissemination.
  ['extramural direct', rec('Extramural-Authored Publication'),
    { showPeerReview: true, showBaoApproval: true, showSpnStages: false, showAcceptedManuscript: false, directDisseminationOnly: true }],
  // Helpers undefined -> peer+bao default shown, spn off (no type match), AM off.
  ['undefined helpers', rec('Poster or Presentation'),
    { showPeerReview: true, showBaoApproval: true, showSpnStages: false, showAcceptedManuscript: false, directDisseminationOnly: false }],
]

let pass = 0, fail = 0
for (const [label, r, expected] of cases) {
  const got = computeVisibility(r)
  if (eq(got, expected)) { pass++; console.log('PASS  ' + label) }
  else { fail++; console.log('FAIL  ' + label); console.log('  expected', expected); console.log('  got     ', got) }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
