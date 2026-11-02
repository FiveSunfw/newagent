const evaluationDirectives = [
  /Use the fixed independent acceptance and contract smoke; do not edit tests, fixtures, or configuration\.?/gi,
  /Use the fixed independent acceptance; do not edit tests, fixtures, or configuration\.?/gi,
];

/** Keep execution-policy boilerplate out of the initial repository search query. */
export function retrievalQuery(requirement: string) {
  return evaluationDirectives
    .reduce((query, directive) => query.replace(directive, " "), requirement)
    .replace(/\s+/g, " ")
    .trim();
}
