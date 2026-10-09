// A small stand-in for Firefox `browser.publicSuffix`. Like Firefox 157, it
// returns null from getDomain for a host on a top-level domain that is not
// on its list, and null from getKnownSuffix when no suffix matches.
const KNOWN = ["com", "io", "github.io", "uk", "co.uk", "example"];

const knownSuffix = (host: string) =>
  KNOWN.filter((s) => host === s || host.endsWith(`.${s}`)).toSorted((a, b) => b.length - a.length)[0] ?? null;

export const psl = {
  getKnownSuffix: knownSuffix,
  getDomain(host: string) {
    const suffix = knownSuffix(host);
    if (!suffix || host === suffix) return null;
    const label = host.slice(0, -suffix.length - 1).split(".").pop();
    return `${label}.${suffix}`;
  },
};
