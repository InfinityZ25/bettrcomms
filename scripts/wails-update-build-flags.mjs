import { pathToFileURL } from 'node:url';

/** Public release configuration only. Never accept signing secrets here. */
export function updateBuildFlags(env) {
  const feed = env.BETTERCOMMS_BUILD_UPDATE_FEED || '';
  const key = env.BETTERCOMMS_BUILD_UPDATE_PUBLIC_KEY || '';
  const hosts = env.BETTERCOMMS_BUILD_UPDATE_DOWNLOAD_HOSTS || '';
  const team = env.BETTERCOMMS_BUILD_UPDATE_MAC_TEAM_ID || '';
  if (![feed, key, hosts, team].some(Boolean)) return '';
  if (!feed || !key) throw new Error('Updates require both the HTTPS feed and public Ed25519 key.');
  const url = new URL(feed);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || /[\s'"\\]/.test(feed)) {
    throw new Error('The update feed must be an HTTPS URL on port 443 without credentials or fragments.');
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) {
    throw new Error('The public update key must be a base64 Ed25519 public key (32 bytes).');
  }
  if (hosts && !hosts.split(',').every(host => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(host))) {
    throw new Error('Update download hosts must be a comma-separated list of hostnames without paths or ports.');
  }
  if (team && !/^[A-Z0-9]{10}$/.test(team)) throw new Error('The macOS signing Team ID must contain ten uppercase letters or digits.');
  return [
    ['bakedUpdateFeed', feed],
    ['bakedUpdatePublicKey', key],
    ['bakedUpdateDownloadHosts', hosts.toLowerCase()],
    ['bakedUpdateMacTeamID', team],
  ].filter(([, value]) => value).map(([name, value]) => '-X main.' + name + '=' + value).join(' ');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(updateBuildFlags(process.env)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
