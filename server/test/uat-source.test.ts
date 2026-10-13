import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, formatFeedCounts, type Aircraft, type SourceStatus } from "@shared/index.js";
import { Poller, type PollerOptions } from "../src/datasource.js";
import type { RouteEnricher } from "../src/enrich/routes.js";

const RADIO = "http://radio.test/aircraft.json";
const UAT = "http://uat.test/aircraft.json";
const stubEnricher = { enrichSync: () => ({}) } as unknown as RouteEnricher;

function run(uatUrl: string, feeds: Record<string, unknown>) {
  const snaps: Aircraft[][] = [];
  const statuses: SourceStatus[] = [];
  const opts: PollerOptions = {
    source: "radio",
    pollMs: 1000,
    supplementApi: false,
    apiPollMs: 4000,
    getConfig: () => ({ ...DEFAULT_CONFIG, radioUrl: RADIO, uatUrl }),
    enricher: stubEnricher,
    onSnapshot: (_n, a) => snaps.push(a),
    onStatus: (s) => statuses.push(s),
  };
  const fetchSpy = vi.fn(async (url: string) => {
    const body = feeds[url];
    if (body === undefined) throw new Error("down");
    return { ok: true, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { poller: new Poller(opts), snaps, statuses, fetchSpy };
}

describe("UAT (dump978) feed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("merges both feeds and tags each aircraft with its receiver", async () => {
    const { poller, snaps } = run(UAT, {
      [RADIO]: { aircraft: [{ hex: "aaa111", lat: 1, lon: 1 }] },
      [UAT]: { aircraft: [{ hex: "bbb222", lat: 1, lon: 1 }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    const byHex = Object.fromEntries(snaps.at(-1)!.map((a) => [a.hex, a.link]));
    expect(byHex).toEqual({ aaa111: "adsb", bbb222: "uat" });
  });

  it("prefers the UAT fix when both receivers hear the same aircraft", async () => {
    const { poller, snaps } = run(UAT, {
      [RADIO]: { aircraft: [{ hex: "aaa111", lat: 1, lon: 1, seen: 0.1 }] },
      [UAT]: { aircraft: [{ hex: "aaa111", lat: 2, lon: 2, seen: 5 }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    const list = snaps.at(-1)!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ link: "uat", lat: 2 });
  });

  it("never fetches UAT when uatUrl is empty", async () => {
    const { poller, snaps, fetchSpy } = run("", {
      [RADIO]: { aircraft: [{ hex: "aaa111" }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(fetchSpy.mock.calls.map((c) => c[0])).not.toContain(UAT);
    expect(snaps.at(-1)![0].link).toBe("adsb");
  });

  it("keeps the 1090 feed alive when the UAT receiver is down", async () => {
    const { poller, snaps, statuses } = run(UAT, {
      [RADIO]: { aircraft: [{ hex: "aaa111" }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(snaps.at(-1)!.map((a) => a.hex)).toEqual(["aaa111"]);
    expect(statuses.at(-1)!.ok).toBe(true);
  });

  it("keeps UAT alive when the 1090 feed is down", async () => {
    const { poller, snaps, statuses } = run(UAT, {
      [UAT]: { aircraft: [{ hex: "bbb222" }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(snaps.at(-1)!.map((a) => [a.hex, a.link])).toEqual([["bbb222", "uat"]]);
    expect(statuses.at(-1)!.ok).toBe(true);
    expect(statuses.at(-1)!.down).toEqual(["adsb"]);
  });

  it("fails the tick and blames radio when both feeds are down", async () => {
    const { poller, statuses } = run(UAT, {});
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    const last = statuses.at(-1)!;
    expect(last.ok).toBe(false);
    expect(last.message).toMatch(/^radio fetch failed/);
  });
});

describe("status feed breakdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("counts each aircraft under the feed it came from", async () => {
    const { poller, statuses } = run(UAT, {
      [RADIO]: { aircraft: [{ hex: "a1", flight: "Fa1" }, { hex: "a2", flight: "Fa2" }] },
      [UAT]: { aircraft: [{ hex: "b1", flight: "Fb1" }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    const s = statuses.at(-1)!;
    expect(s).toMatchObject({ counts: { adsb: 2, uat: 1 }, down: [] });
    expect(formatFeedCounts(s)).toBe("2 ADS-B · 1 UAT");
  });

  it("leaves aircraft without a callsign out of the counts", async () => {
    const { poller, statuses, snaps } = run(UAT, {
      [RADIO]: { aircraft: [{ hex: "a1", flight: "UAL1 " }, { hex: "a2" }, { hex: "a3", flight: "  " }] },
      [UAT]: { aircraft: [{ hex: "b1", flight: "N123AB" }, { hex: "b2" }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(statuses.at(-1)!.counts).toEqual({ adsb: 1, uat: 1 });
    expect(snaps.at(-1)).toHaveLength(5); // still displayed
  });

  it("marks only the failed receiver as down", async () => {
    const { poller, statuses } = run(UAT, {
      [UAT]: { aircraft: [{ hex: "b1", flight: "Fb1" }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    const s = statuses.at(-1)!;
    expect(s.down).toEqual(["adsb"]);
    expect(formatFeedCounts(s)).toBe("ADS-B down · 1 UAT");
  });

  it("marks UAT down while ADS-B keeps reporting", async () => {
    const { poller, statuses } = run(UAT, {
      [RADIO]: { aircraft: [{ hex: "a1", flight: "Fa1" }] },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(formatFeedCounts(statuses.at(-1)!)).toBe("1 ADS-B · UAT down");
  });

  it("omits UAT entirely when it isn't configured", async () => {
    const { poller, statuses } = run("", { [RADIO]: { aircraft: [{ hex: "a1", flight: "Fa1" }] } });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(formatFeedCounts(statuses.at(-1)!)).toBe("1 ADS-B");
  });
});
