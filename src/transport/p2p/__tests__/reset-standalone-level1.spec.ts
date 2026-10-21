import { describe, it, expect, vi } from "vitest";
import { STATION_SN, connectedSession, routerWithSession } from "./session-fixtures.js";

type Manager = { resetWhenUnused: (key: string) => Promise<void> };

describe("resetStandaloneSession", () => {
  it("keeps a standalone station's level-1 session open", async () => {
    const router = routerWithSession(connectedSession(false));
    const manager = (router as unknown as { manager: Manager }).manager;
    const reset = vi.spyOn(manager, "resetWhenUnused").mockResolvedValue(undefined);

    await router.resetStandaloneSession(STATION_SN);

    expect(reset).not.toHaveBeenCalled();
  });

  it("resets a standalone station's level-2 session", async () => {
    const router = routerWithSession(connectedSession(true));
    const manager = (router as unknown as { manager: Manager }).manager;
    const reset = vi.spyOn(manager, "resetWhenUnused").mockResolvedValue(undefined);

    await router.resetStandaloneSession(STATION_SN);

    expect(reset).toHaveBeenCalledWith(STATION_SN);
  });

  it("resets a standalone station with no open session", async () => {
    const router = routerWithSession(connectedSession(false), { register: false });
    const manager = (router as unknown as { manager: Manager }).manager;
    const reset = vi.spyOn(manager, "resetWhenUnused").mockResolvedValue(undefined);

    await router.resetStandaloneSession(STATION_SN);

    expect(reset).toHaveBeenCalledWith(STATION_SN);
  });
});
