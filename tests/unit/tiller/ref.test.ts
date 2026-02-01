/**
 * Tests for reference resolution utilities
 */

import { describe, expect, test } from "vitest";
import {
	extractPhaseIdFromPath,
	extractPlanRefFromPath,
	normalizePhaseId,
	normalizePlanRef,
	parseInitiativeRef,
} from "../../../src/tiller/utils/ref.js";

describe("normalizePlanRef", () => {
	test("passes through canonical format", () => {
		expect(normalizePlanRef("06.6-25")).toBe("06.6-25");
		expect(normalizePlanRef("01.1-01")).toBe("01.1-01");
	});

	test("normalizes missing leading zero", () => {
		expect(normalizePlanRef("6.6-25")).toBe("06.6-25");
		expect(normalizePlanRef("1.1-1")).toBe("01.1-01");
	});

	test("normalizes dash separator in phase", () => {
		expect(normalizePlanRef("06-6-25")).toBe("06.6-25");
		expect(normalizePlanRef("1-1-1")).toBe("01.1-01");
	});

	test("normalizes dot separator for plan", () => {
		expect(normalizePlanRef("06.6.25")).toBe("06.6-25");
	});

	test("normalizes extra dot", () => {
		expect(normalizePlanRef("06.6.-25")).toBe("06.6-25");
	});

	test("returns null for invalid format", () => {
		expect(normalizePlanRef("invalid")).toBeNull();
		expect(normalizePlanRef("06")).toBeNull();
		expect(normalizePlanRef("06.6")).toBeNull();
	});
});

describe("normalizePhaseId", () => {
	test("passes through canonical format", () => {
		expect(normalizePhaseId("06.6")).toBe("06.6");
		expect(normalizePhaseId("01.1")).toBe("01.1");
	});

	test("normalizes missing leading zero", () => {
		expect(normalizePhaseId("6.6")).toBe("06.6");
		expect(normalizePhaseId("1.1")).toBe("01.1");
	});

	test("normalizes dash separator", () => {
		expect(normalizePhaseId("06-6")).toBe("06.6");
	});

	test("handles integer phases", () => {
		expect(normalizePhaseId("06")).toBe("06");
		expect(normalizePhaseId("6")).toBe("06");
	});

	test("returns null for invalid format", () => {
		expect(normalizePhaseId("invalid")).toBeNull();
	});
});

describe("extractPlanRefFromPath", () => {
	test("extracts from standard path", () => {
		expect(
			extractPlanRefFromPath(".planning/phases/06.6-name/06.6-25-PLAN.md"),
		).toBe("06.6-25");
		expect(
			extractPlanRefFromPath("specs/init/phases/01-name/01-01-PLAN.md"),
		).toBe("01-01");
	});

	test("returns null for non-plan files", () => {
		expect(extractPlanRefFromPath("06.6-25-SUMMARY.md")).toBeNull();
		expect(extractPlanRefFromPath("README.md")).toBeNull();
	});
});

describe("extractPhaseIdFromPath", () => {
	test("extracts from directory path", () => {
		expect(extractPhaseIdFromPath("06.6-tiller-ax")).toBe("06.6");
		expect(extractPhaseIdFromPath(".planning/phases/06.6-tiller-ax")).toBe(
			"06.6",
		);
	});

	test("returns null for non-phase directories", () => {
		expect(extractPhaseIdFromPath("random-name")).toBeNull();
	});
});

describe("parseInitiativeRef", () => {
	test("parses initiative:ref format", () => {
		const result = parseInitiativeRef("dogfooding:01-19");
		expect(result.initiative).toBe("dogfooding");
		expect(result.ref).toBe("01-19");
	});

	test("parses tiller-cli initiative", () => {
		const result = parseInitiativeRef("tiller-cli:06.6-25");
		expect(result.initiative).toBe("tiller-cli");
		expect(result.ref).toBe("06.6-25");
	});

	test("returns null initiative for plain ref", () => {
		const result = parseInitiativeRef("06.6-25");
		expect(result.initiative).toBeNull();
		expect(result.ref).toBe("06.6-25");
	});

	test("returns null initiative for ref without digit after colon", () => {
		// Colon not followed by digit - not initiative:ref syntax
		const result = parseInitiativeRef("C:/path/to/file");
		expect(result.initiative).toBeNull();
		expect(result.ref).toBe("C:/path/to/file");
	});

	test("handles colon at start (no initiative)", () => {
		const result = parseInitiativeRef(":01-19");
		expect(result.initiative).toBeNull();
		expect(result.ref).toBe(":01-19");
	});

	test("parses ahoy initiative", () => {
		const result = parseInitiativeRef("ahoy:01-01");
		expect(result.initiative).toBe("ahoy");
		expect(result.ref).toBe("01-01");
	});
});
