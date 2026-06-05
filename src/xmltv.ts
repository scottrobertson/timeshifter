import type { EpgProgram } from "./source.js";

// A small XMLTV parser. We only need <programme> elements: their start/stop
// times and title. Providers include unix timestamps in the attributes
// (start_timestamp / stop_timestamp), which we prefer since they're unambiguous.

const PROGRAMME = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;

function attr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1];
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** XMLTV start/stop look like "20260612173000 +0100"; take the local digits. */
function toLocalString(xmltvTime: string): string {
  const d = xmltvTime.trim().slice(0, 14);
  if (d.length < 14) return "";
  return (
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ` +
    `${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`
  );
}

/**
 * Parse programmes for the wanted channel ids out of an XMLTV document, grouped
 * by channel id. Only the wanted channels are built, so a huge guide stays cheap.
 */
export function parseProgrammes(
  xml: string,
  wantedChannelIds: Set<string>,
): Map<string, EpgProgram[]> {
  const byChannel = new Map<string, EpgProgram[]>();

  for (const match of xml.matchAll(PROGRAMME)) {
    const attrs = match[1]!;
    const channelId = attr(attrs, "channel");
    if (!channelId || !wantedChannelIds.has(channelId)) continue;

    const startEpoch = Number(attr(attrs, "start_timestamp"));
    const stopEpoch = Number(attr(attrs, "stop_timestamp"));
    const startLocal = toLocalString(attr(attrs, "start") ?? "");
    if (!startEpoch || !stopEpoch || !startLocal) continue;

    const body = match[2]!;
    const title = decodeEntities(
      body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "",
    );
    const description = decodeEntities(
      body.match(/<desc\b[^>]*>([\s\S]*?)<\/desc>/)?.[1] ?? "",
    );

    const program: EpgProgram = {
      title: title || "Untitled",
      description,
      start: new Date(startEpoch * 1000),
      end: new Date(stopEpoch * 1000),
      startLocal,
      hasArchive: true, // the source narrows this to the archive window
    };

    const list = byChannel.get(channelId);
    if (list) list.push(program);
    else byChannel.set(channelId, [program]);
  }

  return byChannel;
}
