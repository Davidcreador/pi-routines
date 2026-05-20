import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-tok-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const tokenFile = path.join(tmpHome, ".pi/agent/extensions/routines/tokens.json");
const tokens = await import("../src/tokens.ts");

after(async () => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
	tokens._resetTokenCache();
	await fs.rm(path.dirname(tokenFile), { recursive: true, force: true });
});

describe("tokens", () => {
	it("generateToken returns 64-hex string and persists with mode 0o600", async () => {
		const t = await tokens.generateToken("r1");
		assert.match(t, /^[0-9a-f]{64}$/);
		const st = await fs.stat(tokenFile);
		assert.equal(st.mode & 0o777, 0o600);
	});

	it("verifyToken accepts the stored token, rejects wrong/missing", async () => {
		const t = await tokens.generateToken("r1");
		assert.equal(await tokens.verifyToken("r1", t), true);
		assert.equal(await tokens.verifyToken("r1", "wrong"), false);
		assert.equal(await tokens.verifyToken("r1", `${t}x`), false); // length-mismatch
		assert.equal(await tokens.verifyToken("unknown", t), false);
	});

	it("rotateToken replaces and revokes the old", async () => {
		const a = await tokens.generateToken("r1");
		const b = await tokens.rotateToken("r1");
		assert.notEqual(a, b);
		assert.equal(await tokens.verifyToken("r1", a), false);
		assert.equal(await tokens.verifyToken("r1", b), true);
	});

	it("revokeToken removes the token", async () => {
		const t = await tokens.generateToken("r1");
		await tokens.revokeToken("r1");
		assert.equal(await tokens.verifyToken("r1", t), false);
	});

	it("refuses to read a token file with mode wider than 0o600", async () => {
		await tokens.generateToken("r1");
		// Widen the file.
		await fs.chmod(tokenFile, 0o644);
		tokens._resetTokenCache();
		await assert.rejects(() => tokens.verifyToken("r1", "anything"), /wider than 600/);
	});

	it("maskToken hides all but the first 8 chars", () => {
		const t = "a".repeat(64);
		const masked = tokens.maskToken(t);
		assert.equal(masked, `${"a".repeat(8)}...`);
	});
});
