// Possible Improvements
//
// Change the pull command to skip already-fetched grammars by default. Add a
// --force option to re-fetch all grammars.
//
// Add the ls command to list all languages (see mise ls) and the outdated
// command to list outdated languages (see mise outdated). These commands should
// be implemented together.
//
// Add the new command to create a new language.
//
// Enforce stricter rules for language configuration:
// - extends must be used together with syntax.replace
// - extends cannot be used with syntax.colors
// - file paths must not start or end with a slash
// - file paths must be normalized
// - file paths must point to json or yaml files
// - syntax.colors must be alphabetically ordered

// File system operations in this file could be written to perform in parallel,
// but modern machines are so fast that such an optimization is impractical for
// our scale.

/**
 * @import {Theme} from "./theme.js"
 */

import fs from "node:fs/promises";
import path from "node:path";
import stream from "node:stream";
import util from "node:util";
import * as shikiCore from "@shikijs/core";
import * as shikiEngineOniguruma from "@shikijs/engine-oniguruma";
import shikiEngineOnigurumaWasm from "@shikijs/engine-oniguruma/wasm-inlined";
import * as valibotToJsonSchema from "@valibot/to-json-schema";
import * as r from "@vanyauhalin/result";
import * as yaml from "js-yaml";
import sade from "sade";
import * as v from "valibot";
import { darkColors, lightColors, sharedColors } from "./editor.js";
import pkg from "./package.json" with { type: "json" };
import { darkTheme, darkThemeVariableA, lightTheme } from "./theme.js";

const SettingsSchema = v.object({
	"files.associations": v.record(v.string(), v.string()),
});

const LangConfigSchema = v.object({
	extends: v.pipe(
		v.optional(v.string(), ""),
		v.title("Parent Configuration"),
		v.description("Identifier of the configuration to inherit from."),
	),
	grammar: v.pipe(
		v.object({
			project: v.pipe(
				v.string(),
				v.nonEmpty(),
				v.url(),
				v.regex(/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/),
				v.title("GitHub Project URL"),
				v.description(
					"GitHub repository URL where the grammar files are hosted.",
				),
				v.metadata({
					examples: [
						"https://github.com/microsoft/vscode",
						"https://github.com/bmalehorn/vscode-fish",
					],
				}),
			),
			version: v.pipe(
				v.string(),
				v.nonEmpty(),
				v.title("Grammar Version"),
				v.description(
					"Version identifier for the grammar files, such as a tag or commit hash. Whenever possible, prefer tags to commit hashes.",
				),
				v.metadata({
					examples: ["1.97.2", "2bdcfbea62cadc2a977eace3189d25b31df71e72"],
				}),
			),
			files: v.pipe(
				v.array(
					v.pipe(
						v.string(),
						v.nonEmpty(),
						v.title("Grammar File"),
						v.description(
							"Relative path to a grammar file within the project repository.",
						),
						v.metadata({
							examples: [
								"extensions/css/syntaxes/css.tmLanguage.json",
								"syntaxes/fish.tmLanguage.json",
							],
						}),
					),
				),
				v.title("Grammar Files"),
				v.description(
					"List of relative paths to grammar files within the project repository.",
				),
			),
		}),
		v.title("Grammar Configuration"),
		v.description("Configuration for grammar sourcing."),
	),
	syntax: v.pipe(
		v.object({
			colors: v.pipe(
				v.optional(
					v.record(
						v.string(),
						v.pipe(
							v.union([
								v.pipe(
									v.literal("c0"),
									v.title("c0"),
									v.description(
										"Color for comments, documentation, and similar.",
									),
								),
								v.pipe(
									v.literal("p0"),
									v.title("p0"),
									v.description(
										"Color for keywords, operations, punctuation characters, and similar.",
									),
								),
								v.pipe(
									v.literal("p1"),
									v.title("p1"),
									v.description(
										"Color for variables, identifiers, literals, and similar.",
									),
								),
								v.pipe(
									v.literal("p2"),
									v.title("p2"),
									v.description(
										"Color for Number, Constant, Function Argument, Tag Attribute, Embedded.",
									),
								),
								v.pipe(
									v.literal("s0"),
									v.title("s0"),
									v.description(
										"Color for string quotes, regexp delimiters, and similar.",
									),
								),
								v.pipe(
									v.literal("s1"),
									v.title("s1"),
									v.description(
										"Color for string content, regexp content, and similar.",
									),
								),
							]),
						),
					),
					{},
				),
				v.title("Scope Colors"),
				v.description("Scope names mapped to color codes."),
			),
			replace: v.pipe(
				v.optional(
					v.record(
						v.string(),
						v.pipe(
							v.string(),
							v.title("Scope Replacement"),
							v.description(
								"Pattern replacements for scope name endings during inheritance.",
							),
							v.metadata({
								examples: [".json: .json.comments", ".js.jsx: .tsx"],
							}),
						),
					),
					{},
				),
				v.title("Scope Replacements"),
				v.description(
					"Pattern replacements for scope names endings during inheritance.",
				),
			),
		}),
		v.title("Syntax Configuration"),
		v.description("Configuration for syntax highlighting."),
	),
	test: v.pipe(
		v.optional(
			v.object({
				skip: v.pipe(
					v.optional(v.boolean(), false),
					v.title("Skip Tests"),
					v.description(
						"Whether to skip tests. Consider adding a comment explaining the reason.",
					),
				),
			}),
			{},
		),
		v.title("Test Configuration"),
		v.description("Configuration settings for testing."),
	),
});

const GrammarSchema = v.looseObject({
	name: v.optional(v.string(), ""),
	scopeName: v.string(),
});

/**
 * @typedef {v.InferOutput<typeof SettingsSchema>} Settings
 */

/**
 * @typedef {v.InferOutput<typeof LangConfigSchema>} LangConfig
 */

/**
 * @typedef {v.InferOutput<typeof GrammarSchema>} Grammar
 */

/**
 * @typedef {object} Lang
 * @property {string} id
 * @property {LangConfig} config
 * @property {string} sample
 * @property {string} test
 */

/**
 * @typedef {object} Vendor
 * @property {string} id
 * @property {string} project
 * @property {string} version
 * @property {VendorFile[]} files
 */

/**
 * @typedef {object} VendorFile
 * @property {string} path
 * @property {Grammar} content
 */

/**
 * @typedef {object} EditorTheme
 * @property {string} name
 * @property {Record<string, string>} colors
 * @property {EditorThemeTokenColor[]} tokenColors
 * @property {boolean} semanticHighlighting
 */

/**
 * @typedef {object} EditorThemeTokenColor
 * @property {string[]} scope
 * @property {EditorThemeTokenColorSettings} settings
 */

/**
 * @typedef {object} EditorThemeTokenColorSettings
 * @property {string} foreground
 */

/**
 * @typedef {object} Token
 * @property {string} content
 * @property {string} color
 */

/**
 * @returns {void}
 */
function main() {
	sade("cli.js")
		.describe("Moondust Theme development toolkit.")
		.command("build")
		.describe(["Build themes.", "Accepts optional list of language IDs."])
		.action(async (o) => {
			const h = await handleBuild(o);
			if (h.err) {
				process.stdout.write(`${format(h.err)}\n`);
				process.exitCode = 1;
			}
		})
		.command("pull")
		.describe(["Pull grammars.", "Accepts optional list of language IDs."])
		.action(async (o) => {
			const h = await handlerPull(o);
			if (h.err) {
				process.stdout.write(`${format(h.err)}\n`);
				process.exitCode = 1;
			}
		})
		.command("schema")
		.describe("Generate lang-config.json.")
		.action(async () => {
			const h = await handleSchema();
			if (h.err) {
				process.stdout.write(`${format(h.err)}\n`);
				process.exitCode = 1;
			}
		})
		.command("scopes")
		.describe(["List scopes.", "Accepts optional list of language IDs."])
		.action(async (o) => {
			const h = await handleScopes(process.stdout, o);
			if (h.err) {
				process.stdout.write(`${format(h.err)}\n`);
				process.exitCode = 1;
			}
		})
		.command("test")
		.describe(["Test languages.", "Accepts optional list of language IDs."])
		.action(async (o) => {
			const h = await handconstest(process.stdout, o);
			if (h.err) {
				process.stdout.write(`${format(h.err)}\n`);
				process.exitCode = 1;
				return;
			}

			if (h.v) {
				process.exitCode = 1;
			} else {
				process.exitCode = 0;
			}
		})
		.parse(process.argv);
}

/**
 * @param {object} o
 * @param {string[]} o._
 * @returns {Promise<r.Result<void>>}
 */
async function handleBuild(o) {
	const la = await readLangs();
	if (la.err) {
		return r.err(new Error("Reading langs", { cause: la.err }));
	}

	if (o._.length !== 0) {
		/** @type {Lang[]} */
		const lf = [];

		for (const ln of la.v) {
			if (o._.includes(ln.id)) {
				lf.push(ln);
			}
		}

		la.v = lf;
	}

	/** @type {string[]} */
	const na = [
		"Moondust: Near Side of the Moon",
		"Moondust: Far Side of the Moon",
		"Moondust: Apollo 17 in Shorty",
	];

	/** @type {Theme[]} */
	const ta = [lightTheme(), darkTheme(), darkThemeVariableA()];

	/** @type {Record<string, string>[]} */
	const ca = [
		{
			...sharedColors(),
			...lightColors(ta[0].editor),
		},
		{
			...sharedColors(),
			...darkColors(ta[1].editor),
		},
		{
			...sharedColors(),
			...darkColors(ta[2].editor),
		},
	];

	const ea = createThemes(na, ta, ca, la.v);
	if (ea.err) {
		return r.err(new Error("Create themes", { cause: ea.err }));
	}

	const wt = await writeThemes(ea.v);
	if (wt.err) {
		return r.err(new Error("Writhing themes", { cause: wt.err }));
	}

	return r.ok();
}

/**
 * @param {object} o
 * @param {string[]} o._
 * @param {boolean} o.force
 * @returns {Promise<r.Result<void>>}
 */
async function handlerPull(o) {
	const la = await readLangs();
	if (la.err) {
		return r.err(new Error("Reading langs", { cause: la.err }));
	}

	if (o._.length !== 0) {
		/** @type {Lang[]} */
		const lf = [];

		for (const ln of la.v) {
			if (o._.includes(ln.id)) {
				lf.push(ln);
			}
		}

		la.v = lf;
	}

	const pg = await pullGrammars(la.v);
	if (pg.err) {
		return r.err(new Error("Puling grammars", { cause: pg.err }));
	}

	return r.ok();
}

/**
 * @returns {Promise<r.Result<void>>}
 */
async function handleSchema() {
	/** @type {(p: string, c: string, e: "utf8") => Promise<void>} */
	const wf = fs.writeFile;

	const js = r.safeSync(valibotToJsonSchema.toJsonSchema, LangConfigSchema);
	if (js.err) {
		return r.err(new Error("Creating schema", { cause: js.err }));
	}

	const jp = "lang-config.json";

	const jc = JSON.stringify(js.v, null, "\t");

	const jw = await r.safeAsync(wf, jp, jc, "utf8");
	if (jw.err) {
		return r.err(new Error("Writing schema", { cause: jw.err }));
	}

	return r.ok();
}

/**
 * @param {stream.Writable} wr
 * @param {object} o
 * @param {string[]} o._
 * @returns {Promise<r.Result<void>>}
 */
async function handleScopes(wr, o) {
	const la = await readLangs();
	if (la.err) {
		return r.err(new Error("Reading langs", { cause: la.err }));
	}

	if (o._.length !== 0) {
		/** @type {Lang[]} */
		const lf = [];

		for (const ln of la.v) {
			if (o._.includes(ln.id)) {
				lf.push(ln);
			}
		}

		la.v = lf;
	}

	const ga = await readGrammars(la.v);
	if (ga.err) {
		return r.err(new Error("Reading grammars", { cause: ga.err }));
	}

	const ss = collectScopes(ga.v);

	for (const [i, sa] of ss.entries()) {
		for (const sc of sa) {
			wr.write(`${sc}\n`);
		}

		if (i !== ss.length - 1) {
			wr.write("\n");
		}
	}

	return r.ok();
}

/**
 * @param {stream.Writable} wr
 * @param {object} o
 * @param {string[]} o._
 * @returns {Promise<r.Result<boolean>>}
 */
async function handconstest(wr, o) {
	const tr = new TestRunner(wr);

	const la = await readLangs();
	if (la.err) {
		return r.err(new Error("Reading langs", { cause: la.err }));
	}

	const ga = await readGrammars(la.v);
	if (ga.err) {
		return r.err(new Error("Reading grammars", { cause: ga.err }));
	}

	/** @type {string[]} */
	const na = ["Moondust: Cardboard Moon"];

	/** @type {Theme[]} */
	const ta = [lightTheme()];

	/** @type {Record<string, string>[]} */
	const ca = [{}];

	const ea = createThemes(na, ta, ca, la.v);
	if (ea.err) {
		return r.err(new Error("Create themes", { cause: ea.err }));
	}

	const th = ta[0];

	// Filter languages after loading all grammars because grammars have
	// interdependencies. Running tests in isolation is problematic.

	if (o._.length !== 0) {
		/** @type {Lang[]} */
		const lf = [];

		for (const ln of la.v) {
			if (o._.includes(ln.id)) {
				lf.push(ln);
			}
		}

		la.v = lf;
	}

	const et = ea.v[0];

	testLangs(tr, th, la.v, ga.v, et);

	const tf = await tr.run();

	return r.ok(tf);
}

/**
 * @returns {Promise<r.Result<Lang[]>>}
 */
async function readLangs() {
	/** @type {(p: string) => Promise<string[]>} */
	const rd = fs.readdir;

	/** @type {(p: string, e: "utf8") => Promise<string>} */
	const rf = fs.readFile;

	const xp = "langs";

	const xd = await r.safeAsync(rd, xp);
	if (xd.err) {
		return r.err(new Error("Reading dir", { cause: xd.err }));
	}

	/** @type {Record<string, Lang>} */
	const lr = {};

	/** @type {Error[]} */
	const errs = [];

	for (const xn of xd.v) {
		const yp = path.join(xp, xn);

		const yd = await r.safeAsync(rd, yp);
		if (yd.err) {
			errs.push(new Error("Reading dir", { cause: yd.err }));
			continue;
		}

		/** @type {LangConfig | undefined} */
		let lc;

		/** @type {string | undefined} */
		let ls;

		/** @type {string | undefined} */
		let lt;

		for (const yn of yd.v) {
			const zp = path.join(yp, yn);

			const zf = await r.safeAsync(rf, zp, "utf8");
			if (zf.err) {
				errs.push(new Error("Reading file", { cause: zf.err }));
				continue;
			}

			switch (yn) {
				case "config.yaml": {
					const cl = r.safeSync(yaml.load, zf.v);
					if (cl.err) {
						errs.push(new Error(`Parsing yaml "${zf.v}"`, { cause: cl.err }));
						continue;
					}

					const cp = r.safeSync(v.parse, LangConfigSchema, cl.v);
					if (cp.err) {
						errs.push(new Error(`Parsing schema "${zf.v}"`, { cause: cp.err }));
						continue;
					}

					if (!cp.v.grammar.project.endsWith("/")) {
						cp.v.grammar.project += "/";
					}

					lc = cp.v;
					break;
				}

				case "sample":
					ls = zf.v;
					break;

				case "test.js":
					lt = zf.v;
					break;
			}
		}

		if (lc) {
			if (!ls) {
				ls = "";
			}

			if (!lt) {
				lt = "";
			}

			/** @type {Lang} */
			const ln = {
				id: xn,
				config: lc,
				sample: ls,
				test: lt,
			};

			lr[xn] = ln;
		}
	}

	if (errs.length !== 0) {
		return r.err(new Error("Iterating dir", { cause: errs }));
	}

	for (const id of Object.keys(lr)) {
		const ln = lr[id];

		if (ln.config.extends && !lr[ln.config.extends]) {
			errs.push(new Error(`Invalid extends "${ln.config.extends}" in "${id}"`));
		}
	}

	if (errs.length !== 0) {
		return r.err(new Error("Validating configs", { cause: errs }));
	}

	/** @type {string[][]} */
	const sa = [];

	for (const id of Object.keys(lr)) {
		let d = 0;
		let ln = lr[id];

		while (ln.config.extends) {
			d += 1;
			ln = lr[ln.config.extends];
		}

		if (!sa[d]) {
			sa[d] = [];
		}

		sa[d].push(id);
	}

	for (const sb of sa) {
		for (const id of sb) {
			const ln = lr[id];

			if (ln.config.extends) {
				const le = lr[ln.config.extends];

				const sc = {
					...le.config.syntax.colors,
				};

				for (const [from, to] of Object.entries(ln.config.syntax.replace)) {
					const r = new RegExp(`(${from})(\\s+|$)`, "g");

					for (const [k, v] of Object.entries(sc)) {
						const newKey = k.replace(r, `${to}$2`);
						sc[newKey] = v;
						delete sc[k];
					}
				}

				ln.config.syntax.colors = sc;

				ln.sample = le.sample;
				ln.test = le.test;
			}
		}
	}

	return r.ok(Object.values(lr));
}

/**
 * @param {TestRunner} tr
 * @param {Theme} th
 * @param {Lang[]} la
 * @param {Vendor[]} ga
 * @param {EditorTheme} et
 * @returns {void}
 */
function testLangs(tr, th, la, ga, et) {
	/** @type {(ln: Lang, hg: shikiCore.HighlighterGeneric<string, string>) => r.Result<Token[][]>} */
	const tokenize = (ln, hg) => {
		/** @type {shikiCore.CodeToTokensOptions<string, string>} */
		const so = {
			lang: ln.id,
			theme: et.name,
		};

		const sr = r.safeSync(hg.codeToTokens, ln.sample, so);
		if (sr.err) {
			return r.err(new Error("Tokenizing code", { cause: sr.err }));
		}

		/** @type {Token[][]} */
		const ts = [];

		/** @type {Error[]} */
		const errs = [];

		for (const sa of sr.v.tokens) {
			/** @type {Token[]} */
			const ca = [];

			for (const st of sa) {
				/** @type {Token | undefined} */
				let pt;

				if (ca.length !== 0) {
					pt = ca[ca.length - 1];
				}

				/** @type {string | undefined} */
				let cl;

				switch (st.color) {
					case th.syntax.comment[0]:
						cl = "c0";
						break;
					case th.syntax.plain[0]:
						cl = "p0";
						break;
					case th.syntax.plain[1]:
						cl = "p1";
						break;
					case th.syntax.plain[2]:
						cl = "p2";
						break;
					case th.syntax.string[0]:
						cl = "s0";
						break;
					case th.syntax.string[1]:
						cl = "s1";
						break;
					default:
						errs.push(new Error(`Unknown color "${st.color}"`));
						continue;
				}

				if (pt && pt.color === cl) {
					pt.content += st.content;
					continue;
				}

				const cn = st.content.trimStart();

				if (pt && cn.length !== st.content.length) {
					pt.content += " ".repeat(st.content.length - cn.length);
				}

				if (!cn) {
					continue;
				}

				if (pt) {
					pt.content = pt.content.trimEnd();
				}

				/** @type {Token} */
				const ct = {
					content: cn,
					color: cl,
				};

				ca.push(ct);
			}

			ts.push(ca);
		}

		if (errs.length !== 0) {
			return r.err(new Error("Iterating tokens", { cause: errs }));
		}

		while (ts.length !== 0 && ts[ts.length - 1].length === 0) {
			ts.pop();
		}

		return r.ok(ts);
	};

	/** @type {(ln: Lang) => r.Result<Token[][]>} */
	const exec = (ln) => {
		const er = /^\s*at eval \(test\.js:(\d+):(\d+)\)$/;

		const ec = `${ln.test}\n//# sourceURL=test.js`;

		/** @type {r.Result<any>} */
		const ef = r.safeNew(Function, "c0", "p0", "p1", "p2", "s0", "s1", ec);
		if (ef.err) {
			return r.err(new Error("Creating test", { cause: ef.err }));
		}

		let eo = 0;

		const ew = ef.v.toString().replace(ec, "xxx");

		for (const [i, l] of ew.split("\n").entries()) {
			if (l === "xxx") {
				eo = i;
				break;
			}
		}

		/** @type {Token[][]} */
		const ts = [];

		/** @type {Error[]} */
		const errs = [];

		/** @type {(cc: string) => (...args: unknown[]) => void} */
		const tf = (cl) => {
			return (...args) => {
				const err = new Error(" ");
				if (!err.stack) {
					errs.push(new Error("No stack"));
					return;
				}

				/** @type {RegExpExecArray | null | undefined} */
				let em;

				for (const l of err.stack.split("\n")) {
					em = er.exec(l);
					if (em) {
						break;
					}
				}

				if (!em) {
					errs.push(new Error("No call position"));
					return;
				}

				const el = Number.parseInt(em[1], 10);
				if (Number.isNaN(el)) {
					errs.push(new Error("Invalid call line"));
					return;
				}

				const ec = Number.parseInt(em[2], 10);
				if (Number.isNaN(ec)) {
					errs.push(new Error("Invalid call column"));
					return;
				}

				if (args.length === 0) {
					errs.push(new Error(`No arguments (${el}:${ec})`));
					return;
				}

				if (args.length !== 1) {
					errs.push(new Error(`Too many arguments (${el}:${ec})`));
					return;
				}

				const cn = args[0];

				if (typeof cn !== "string") {
					errs.push(new Error(`Invalid argument type (${el}:${ec})`));
					return;
				}

				if (!cn) {
					errs.push(new Error(`Empty argument (${el}:${ec})`));
					return;
				}

				if (!cn.trim()) {
					errs.push(new Error(`Whitespace argument (${el}:${ec})`));
					return;
				}

				if (cn.trim() !== cn) {
					errs.push(new Error(`Leading or trailing whitespace (${el}:${ec})`));
					return;
				}

				while (ts.length < el - eo) {
					ts.push([]);
				}

				const ca = ts[ts.length - 1];

				/** @type {Token} */
				const ct = {
					content: cn,
					color: cl,
				};

				ca.push(ct);
			};
		};

		const ev = r.safeSync(
			ef.v,
			tf("c0"),
			tf("p0"),
			tf("p1"),
			tf("p2"),
			tf("s0"),
			tf("s1"),
		);
		if (ev.err) {
			return r.err(new Error("Evaluating test", { cause: ev.err }));
		}

		if (errs.length !== 0) {
			return r.err(new Error("Iterating calls", { cause: errs }));
		}

		return r.ok(ts);
	};

	/** @type {(xs: Token[][], ys: Token[][]) => string[]} */
	const compare = (xs, ys) => {
		/** @type {string[]} */
		const ca = [];

		for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
			/** @type {Token[] | undefined} */
			let xa;

			if (xs.length - 1 >= i) {
				xa = xs[i];
			} else {
				xa = [];
			}

			/** @type {Token[] | undefined} */
			let ya;

			if (ys.length - 1 >= i) {
				ya = ys[i];
			} else {
				ya = [];
			}

			let cf = false;

			let c0 = "";
			let c1 = "";

			let c2 = "";
			let c3 = "";

			for (let j = 0; j < Math.max(xa.length, ya.length); j += 1) {
				/** @type {Token | undefined} */
				let xt;

				if (xa.length - 1 >= j) {
					xt = xa[j];
				}

				/** @type {Token | undefined} */
				let yt;

				if (ya.length - 1 >= j) {
					yt = ya[j];
				}

				const eq =
					xt && yt && xt.content === yt.content && xt.color === yt.color;

				if (xt) {
					const xm = Math.max(xt.color.length, xt.content.length);

					let ct = `  ${xt.content}${" ".repeat(xm - xt.content.length)}  `;
					let cb = `└─${xt.color}${"─".repeat(xm - xt.color.length)}─┘`;

					if (eq) {
						ct = util.styconstext("dim", ct);
						cb = util.styconstext("dim", cb);
					}

					c0 += `${ct} `;
					c1 += `${cb} `;
				}

				if (yt) {
					const ym = Math.max(yt.color.length, yt.content.length);

					let ct = `  ${yt.content}${" ".repeat(ym - yt.content.length)}  `;
					let cb = `└─${yt.color}${"─".repeat(ym - yt.color.length)}─┘`;

					if (eq) {
						ct = util.styconstext("dim", ct);
						cb = util.styconstext("dim", cb);
					}

					c2 += `${ct} `;
					c3 += `${cb} `;
				}

				if (!eq) {
					cf = true;
				}
			}

			if (c0.length !== 0) {
				c0 = c0.slice(0, -1);
				c1 = c1.slice(0, -1);
			} else {
				c0 = "<empty line>";
			}

			if (c2.length !== 0) {
				c2 = c2.slice(0, -1);
				c3 = c3.slice(0, -1);
			} else {
				c2 = "<empty line>";
			}

			let cr = "";

			if (cf) {
				cr += `${util.styconstext("dim", util.styconstext("green", "Actual"))}     ${util.styconstext("green", c0)}\n`;

				cr += util.styconstext("dim", util.styconstext("green", "(sample)"));

				if (c1) {
					cr += `   ${util.styconstext("green", c1)}\n`;
				} else {
					cr += "\n";
				}

				cr += "\n";

				cr += `${util.styconstext("dim", util.styconstext("red", "Expected"))}   ${util.styconstext("red", c2)}\n`;

				cr += util.styconstext("dim", util.styconstext("red", "(test.js)"));

				if (c3) {
					cr += `  ${util.styconstext("red", c3)}\n`;
				} else {
					cr += "\n";
				}
			}

			if (cr.length !== 0) {
				cr = cr.slice(0, -1);
			}

			ca.push(cr);
		}

		return ca;
	};

	tr.add(la.length * 4);

	tr.cb(async () => {
		/** @type {(p: string, e: "utf8") => Promise<string>} */
		const rf = fs.readFile;

		const sp = ".vscode/settings.json";

		const sc = await r.safeAsync(rf, sp, "utf8");
		if (sc.err) {
			const err = new Error("Reading file", { cause: sc.err });

			tr.log(sp, format(err));

			for (const _ of la) {
				tr.fail();
			}

			return;
		}

		const sj = r.safeSync(JSON.parse, sc.v);
		if (sj.err) {
			const err = new Error("Parsing json", { cause: sj.err });

			tr.log(sp, format(err));

			for (const _ of la) {
				tr.fail();
			}

			return;
		}

		const ss = r.safeSync(v.parse, SettingsSchema, sj.v);
		if (ss.err) {
			const err = new Error("Parsing schema", { cause: ss.err });

			tr.log(sp, format(err));

			for (const _ of la) {
				tr.fail();
			}

			return;
		}

		for (const ln of la) {
			const lk = `**/langs/${ln.id}/sample*`;

			if (
				!ss.v["files.associations"][lk] &&
				!ln.config.extends &&
				!ln.config.test.skip
			) {
				const m0 = util.styconstext(
					"red",
					`Lang "${ln.id}" must have a file association`,
				);

				/** @type {Settings} */
				const se = {
					"files.associations": {
						[lk]: "<language identifier>",
					},
				};

				const m1 = util.styconstext("dim", JSON.stringify(se, null, 2));

				tr.log(sp, `${m0}\n\n${m1}`);

				tr.fail();

				continue;
			}

			if (ss.v["files.associations"][lk] && ln.config.extends) {
				tr.log(
					sp,
					util.styconstext(
						"red",
						`Lang "${ln.id}" must not have a file association`,
					),
				);
				tr.fail();
				continue;
			}

			tr.pass();
		}
	});

	tr.cb(async () => {
		for (const ln of la) {
			const lp = `langs/${ln.id}/sample`;

			const ac = await r.safeAsync(fs.access, lp);

			if (ac.err && !ln.config.extends && !ln.config.test.skip) {
				tr.log(
					lp,
					util.styconstext("red", `Lang "${ln.id}" must have a sample`),
				);
				tr.fail();
				continue;
			}

			if (!ac.err && ln.config.extends) {
				tr.log(
					lp,
					util.styconstext("red", `Lang "${ln.id}" must not have a sample`),
				);
				tr.fail();
				continue;
			}

			tr.pass();
		}

		for (const ln of la) {
			const lp = `langs/${ln.id}/test.js`;

			const ac = await r.safeAsync(fs.access, lp);

			if (ac.err && !ln.config.extends && !ln.config.test.skip) {
				tr.log(
					lp,
					util.styconstext("red", `Lang "${ln.id}" must have a test.js`),
				);
				tr.fail();
				continue;
			}

			if (!ac.err && ln.config.extends) {
				tr.log(
					lp,
					util.styconstext("red", `Lang "${ln.id}" must not have a test.js`),
				);
				tr.fail();
				continue;
			}

			tr.pass();
		}
	});

	tr.cb(async () => {
		/** @type {shikiCore.CreatedBundledHighlighterOptions<string, string>} */
		const co = {
			langs: {},
			themes: {},
			async engine() {
				return await shikiEngineOniguruma.createOnigurumaEngine(
					shikiEngineOnigurumaWasm,
				);
			},
		};

		const ch = shikiCore.createdBundledHighlighter(co);

		/** @type {shikiCore.BundledHighlighterOptions<string, string>} */
		const ho = {
			langs: [],
			themes: [et],
		};

		for (const ve of ga) {
			for (const vf of ve.files) {
				/** @type {any} */
				const vc = vf.content;
				ho.langs.push(vc);
			}
		}

		const hg = await r.safeAsync(ch, ho);
		if (hg.err) {
			const err = new Error("Creating highlighter", { cause: hg.err });

			tr.log("langs", format(err));

			for (const _ of la) {
				tr.fail();
			}

			return;
		}

		for (const ln of la) {
			if (ln.config.test.skip) {
				tr.skip();
				continue;
			}

			const lp = `langs/${ln.id}/sample`;

			const xs = tokenize(ln, hg.v);
			if (xs.err) {
				const err = new Error("Tokenizing sample", { cause: xs.err });
				tr.log(lp, format(err));
				tr.fail();
				continue;
			}

			const ys = exec(ln);
			if (ys.err) {
				const err = new Error("Executing test", { cause: ys.err });
				tr.log(lp, format(err));
				tr.fail();
				continue;
			}

			const ca = compare(xs.v, ys.v);

			let cf = false;

			for (const [i, cr] of ca.entries()) {
				if (cr) {
					tr.log(`${lp}:${i + 1}`, cr);
					cf = true;
				}
			}

			if (cf) {
				tr.fail();
			} else {
				tr.pass();
			}
		}

		hg.v.dispose();
	});
}

/**
 * @param {Lang[]} la
 * @returns {Promise<r.Result<void>>}
 */
async function pullGrammars(la) {
	/** @type {Vendor[]} */
	const va = [];

	/** @type {Error[][]} */
	const vErrs = [];

	/** @type {Promise<void>[]} */
	const pa = [];

	for (const [i, ln] of la.entries()) {
		/** @type {Vendor} */
		const ve = {
			id: ln.id,
			project: ln.config.grammar.project,
			version: ln.config.grammar.version,
			files: [],
		};

		va[i] = ve;
		vErrs[i] = [];

		for (let j = 0; j < ln.config.grammar.files.length; j += 1) {
			const errs = vErrs[i];

			const pr = /** @returns {Promise<void>} */ (async () => {
				const gf = ln.config.grammar.files[j];

				const fp = path.posix.join("raw", ln.config.grammar.version, gf);

				const fu = r.safeNew(URL, fp, ln.config.grammar.project);
				if (fu.err) {
					errs[j] = new Error("Creating url", { cause: fu.err });
					return;
				}

				const fe = path.posix.extname(fu.v.pathname);

				if (fe !== ".json" && fe !== ".yaml") {
					errs[j] = new Error(`Invalid format "${fe}"`);
					return;
				}

				/** @type {RequestInit} */
				const fo = {
					redirect: "follow",
				};

				const fr = await r.safeAsync(fetch, fu.v, fo);
				if (fr.err) {
					errs[j] = new Error(`Making request "GET ${fu.v}"`, {
						cause: fr.err,
					});
					return;
				}

				if (!fr.v.ok) {
					errs[j] = new Error(`Bad response "GET ${fu.v} ${fr.v.status}"`);
					return;
				}

				const ft = await r.safeAsync(fr.v.text.bind(fr.v));
				if (ft.err) {
					errs[j] = new Error(`Reading response "GET ${fu.v}"`, {
						cause: ft.err,
					});
					return;
				}

				/** @type {unknown} */
				let fc;

				switch (fe) {
					case ".json": {
						const fj = r.safeSync(JSON.parse, ft.v);
						if (fj.err) {
							errs[j] = new Error(`Parsing json "GET ${fu.v}"`, {
								cause: fj.err,
							});
							return;
						}

						fc = fj.v;
						break;
					}

					case ".yaml": {
						const fy = r.safeSync(yaml.load, ft.v);
						if (fy.err) {
							errs[j] = new Error(`Parsing yaml "GET ${fu.v}"`, {
								cause: fy.err,
							});
							return;
						}

						fc = fy.v;
						break;
					}
				}

				const fs = r.safeSync(v.parse, GrammarSchema, fc);
				if (fs.err) {
					errs[j] = new Error(`Parsing schema "GET ${fu.v}"`, {
						cause: fs.err,
					});
					return;
				}

				// Use ID as grammar name for convenient access in tests.
				fs.v.name = ln.id;

				/** @type {VendorFile} */
				const vf = {
					path: gf,
					content: fs.v,
				};

				ve.files[j] = vf;
			})();

			pa.push(pr);
		}
	}

	await Promise.all(pa);

	/** @type {Error[]} */
	const fErrs = [];

	for (const [i, ln] of la.entries()) {
		const ve = vErrs[i];

		/** @type {Error[]} */
		const errs = [];

		for (const err of ve) {
			if (err) {
				errs.push(err);
			}
		}

		if (errs.length !== 0) {
			fErrs.push(new Error(`Fetching grammar "${ln.id}"`, { cause: errs }));
		}
	}

	/** @type {Error | undefined} */
	let fErr;

	if (fErrs.length !== 0) {
		fErr = new Error("Fetching grammars", { cause: fErrs });
	}

	/** @type {(p: string, c: string, e: "utf8") => Promise<void>} */
	const wf = fs.writeFile;

	/** @type {Error[]} */
	const wErrs = [];

	for (const [i, ln] of la.entries()) {
		const ve = va[i];

		/** @type {Error[]} */
		const errs = [];

		for (const vf of ve.files) {
			if (vf) {
				const vu = r.safeNew(URL, ve.project);
				if (vu.err) {
					errs.push(new Error("Creating url", { cause: vu.err }));
					continue;
				}

				const vp = path.join("vendor", vu.v.pathname, ve.version, vf.path);

				const vd = path.dirname(vp);

				const vm = await r.safeAsync(fs.mkdir, vd, { recursive: true });
				if (vm.err) {
					errs.push(new Error("Creating dir", { cause: vm.err }));
					continue;
				}

				const vc = JSON.stringify(vf.content, null, "\t");

				const vw = await r.safeAsync(wf, vp, vc, "utf8");
				if (vw.err) {
					errs.push(new Error("Writing file", { cause: vw.err }));
				}
			}
		}

		if (errs.length !== 0) {
			wErrs.push(new Error(`Writing grammar "${ln.id}"`, { cause: errs }));
		}
	}

	/** @type {Error | undefined} */
	let wErr;

	if (wErrs.length !== 0) {
		wErr = new Error("Writing grammars", { cause: wErrs });
	}

	if (fErr && wErr) {
		return r.err(new Error("Processing grammars", { cause: [fErr, wErr] }));
	}
	if (fErr) {
		return r.err(fErr);
	}
	if (wErr) {
		return r.err(wErr);
	}

	return r.ok();
}

/**
 * @param {Lang[]} la
 * @returns {Promise<r.Result<Vendor[]>>}
 */
async function readGrammars(la) {
	/** @type {(p: string, e: "utf8") => Promise<string>} */
	const rf = fs.readFile;

	/** @type {Vendor[]} */
	const va = [];

	/** @type {Error[]} */
	const errs = [];

	for (const ln of la) {
		/** @type {Vendor} */
		const ve = {
			id: ln.id,
			project: ln.config.grammar.project,
			version: ln.config.grammar.version,
			files: [],
		};

		const vu = r.safeNew(URL, ve.project);
		if (vu.err) {
			errs.push(new Error("Creating url", { cause: vu.err }));
			continue;
		}

		for (const gf of ln.config.grammar.files) {
			const gp = path.join("vendor", vu.v.pathname, ve.version, gf);

			const gc = await r.safeAsync(rf, gp, "utf8");
			if (gc.err) {
				errs.push(new Error("Reading file", { cause: gc.err }));
				continue;
			}

			const gj = r.safeSync(JSON.parse, gc.v);
			if (gj.err) {
				errs.push(new Error(`Parsing json "${gp}"`, { cause: gj.err }));
				continue;
			}

			const gs = r.safeSync(v.parse, GrammarSchema, gj.v);
			if (gs.err) {
				errs.push(new Error(`Parsing schema "${gp}"`, { cause: gs.err }));
				continue;
			}

			/** @type {VendorFile} */
			const vf = {
				path: gf,
				content: gs.v,
			};

			ve.files.push(vf);
		}

		va.push(ve);
	}

	if (errs.length !== 0) {
		return r.err(new Error("Iterating langs", { cause: errs }));
	}

	return r.ok(va);
}

/**
 * @param {Vendor[]} ga
 * @returns {string[][]}
 */
function collectScopes(ga) {
	/** @type {(a: string[], v: unknown) => void} */
	const loop = (a, v) => {
		if (!v) {
			return;
		}

		if (Array.isArray(v)) {
			for (const w of v) {
				loop(a, w);
			}
			return;
		}

		if (typeof v === "object") {
			for (const [k, w] of Object.entries(v)) {
				if (k === "name" && typeof w === "string") {
					a.push(w);
				} else {
					loop(a, w);
				}
			}
			return;
		}
	};

	/** @type {string[][]} */
	const ss = [];

	for (const ve of ga) {
		/** @type {string[]} */
		let sa = [];

		for (const vf of ve.files) {
			loop(sa, vf.content);
		}

		sa = [...new Set(sa)].sort();

		const i = sa.indexOf(ve.id);

		if (i !== -1) {
			sa.splice(i, 1);
		}

		ss.push(sa);
	}

	return ss;
}

/**
 * @param {string[]} na
 * @param {Theme[]} ta
 * @param {Record<string, string>[]} ca
 * @param {Lang[]} la
 * @returns {r.Result<EditorTheme[]>}
 */
function createThemes(na, ta, ca, la) {
	/** @type {EditorTheme[]} */
	const ea = [];

	/** @type {Error[]} */
	const eErrs = [];

	for (const [i, tn] of na.entries()) {
		const th = ta[i];
		const cr = ca[i];

		/** @type {Record<string, string>} */
		const xr = {};

		/** @type {Error[]} */
		const errs = [];

		for (const k of Object.keys(cr).sort()) {
			let v = cr[k];

			while (true) {
				if (!v) {
					errs.push(new Error(`Invalid reference "${k}"`));
					break;
				}

				if (v.startsWith("#")) {
					xr[k] = v;
					break;
				}

				v = cr[v];
			}
		}

		if (errs.length !== 0) {
			eErrs.push(new Error(`Resolving colors "${tn}"`, { cause: errs }));
			continue;
		}

		/** @type {EditorThemeTokenColor[]} */
		const xa = [];

		for (const ln of la) {
			/** @type {Record<string, string[]>} */
			const tr = {
				c0: [],
				p0: [],
				p1: [],
				p2: [],
				s0: [],
				s1: [],
			};

			for (const [k, v] of Object.entries(ln.config.syntax.colors)) {
				tr[v].push(k);
			}

			for (const [k, v] of Object.entries(tr)) {
				if (v.length !== 0) {
					/** @type {EditorThemeTokenColor} */
					const tc = {
						scope: v,
						settings: {
							foreground: "",
						},
					};

					switch (k) {
						case "c0":
							tc.settings.foreground = th.syntax.comment[0];
							break;
						case "p0":
							tc.settings.foreground = th.syntax.plain[0];
							break;
						case "p1":
							tc.settings.foreground = th.syntax.plain[1];
							break;
						case "p2":
							tc.settings.foreground = th.syntax.plain[3];
							break;
						case "s0":
							tc.settings.foreground = th.syntax.string[0];
							break;
						case "s1":
							tc.settings.foreground = th.syntax.string[1];
							break;
					}
					xa.push(tc);
				}
			}
		}

		/** @type {EditorTheme} */
		const et = {
			name: tn,
			colors: xr,
			tokenColors: xa,
			semanticHighlighting: true,
		};

		ea.push(et);
	}

	if (eErrs.length !== 0) {
		return r.err(new Error("Iterating themes", { cause: eErrs }));
	}

	return r.ok(ea);
}

/**
 * @param {EditorTheme[]} ea
 * @returns {Promise<r.Result<void>>}
 */
async function writeThemes(ea) {
	if (pkg.contributes.themes.length !== ea.length) {
		return r.err(new Error("Theme count mismatch"));
	}

	/** @type {(p: string, c: string, e: "utf8") => Promise<void>} */
	const wf = fs.writeFile;

	/** @type {Error[]} */
	const errs = [];

	for (const et of ea) {
		/** @type {string | undefined} */
		let ep;

		for (const pt of pkg.contributes.themes) {
			if (pt.label === et.name) {
				ep = pt.path;
				break;
			}
		}

		if (!ep) {
			errs.push(new Error(`Theme path not found "${et.name}"`));
			continue;
		}

		const ed = path.dirname(ep);

		const em = await r.safeAsync(fs.mkdir, ed, { recursive: true });
		if (em.err) {
			errs.push(new Error("Creating dir", { cause: em.err }));
			continue;
		}

		const ec = JSON.stringify(et, null, "\t");

		const ew = await r.safeAsync(wf, ep, ec, "utf8");
		if (ew.err) {
			errs.push(new Error("Writing file", { cause: ew.err }));
		}
	}

	if (errs.length !== 0) {
		return r.err(new Error("Iterating themes", { cause: errs }));
	}

	return r.ok();
}

/**
 * @param {Error} err
 * @returns {string}
 */
function format(err) {
	let m = "";
	let d = 0;

	/** @type {(s: string) => void} */
	const add = (s) => {
		m += `${"\t".repeat(d)}${s}\n`;
	};

	/** @type {(issues: v.BaseIssue<unknown>[]) => void} */
	const trace = (issues) => {
		for (const i of issues) {
			add(i.message);

			if (i.issues) {
				d += 1;
				trace(i.issues);
				d -= 1;
			}
		}
	};

	/** @type {(err: unknown) => void} */
	const loop = (err) => {
		if (Array.isArray(err)) {
			for (const e of err) {
				loop(e);
			}
			return;
		}

		if (err instanceof v.ValiError) {
			if (err.issues.length === 1) {
				add(`${err.issues.length} issue`);
			} else {
				add(`${err.issues.length} issues`);
			}

			d += 1;
			trace(err.issues);
			d -= 1;

			return;
		}

		if (err instanceof Error) {
			add(err.message);

			if (err.cause) {
				d += 1;
				loop(err.cause);
				d -= 1;
			}

			return;
		}
	};

	loop(err);

	if (m.length !== 0) {
		m = m.slice(0, -1);
	}

	return m;
}

const statusPass = 0;
const statusFail = 1;
const statusSkip = 2;

class TestRunner {
	/**
	 * @private
	 * @type {stream.Writable}
	 */
	wr;

	/**
	 * @private
	 * @type {number}
	 */
	total = 0;

	/**
	 * @private
	 * @type {(() => void | Promise<void>)[]}
	 */
	callbacks = [];

	/**
	 * @private
	 * @type {number[]}
	 */
	statuses = [];

	/**
	 * @private
	 * @type {string}
	 */
	out = "";

	/**
	 * @param {stream.Writable} wr
	 */
	constructor(wr) {
		this.wr = wr;
	}

	/**
	 * @param {number} total
	 * @returns {void}
	 */
	add(total) {
		this.total += total;
	}

	/**
	 * @param {() => void | Promise<void>} fn
	 * @returns {void}
	 */
	cb(fn) {
		this.callbacks.push(fn);
	}

	/**
	 * @param {string} p
	 * @param {string} m
	 * @returns {void}
	 */
	log(p, m) {
		this.out += `${p}\n`;
		this.out += "\n";
		this.out += `${indent(2, m)}\n`;
		this.out += "\n";
	}

	/**
	 * @returns {void}
	 */
	pass() {
		this.statuses.push(statusPass);
		this.tick();
	}

	/**
	 * @returns {void}
	 */
	fail() {
		this.statuses.push(statusFail);
		this.tick();
	}

	/**
	 * @returns {void}
	 */
	skip() {
		this.statuses.push(statusSkip);
		this.tick();
	}

	/**
	 * @private
	 * @returns {void}
	 */
	tick() {
		const t = `${this.total}`;

		let c = `${this.statuses.length}`;

		if (c.length < t.length) {
			c = `${" ".repeat(t.length - c.length)}${c}`;
		}

		this.wr.write(`\r[${c} / ${t}]`);
	}

	/**
	 * @returns {Promise<boolean>}
	 */
	async run() {
		this.tick();

		for (const cb of this.callbacks) {
			await cb();
		}

		this.wr.write("\n");
		this.wr.write("\n");

		const ls = this.out.split("\n");

		for (const [i, l] of ls.entries()) {
			if (i !== ls.length - 1) {
				this.wr.write(`${l}\n`);
			} else {
				this.wr.write(l);
			}
		}

		let pd = 0;
		let sd = 0;

		for (const s of this.statuses) {
			switch (s) {
				case statusPass:
					pd += 1;
					break;
				case statusSkip:
					sd += 1;
					break;
			}
		}

		this.wr.write(`Total:    ${this.total}\n`);
		this.wr.write(`Passed:   ${pd}\n`);
		this.wr.write(`Skipped:  ${sd}\n`);

		for (const s of this.statuses) {
			if (s === statusFail) {
				return true;
			}
		}

		return false;
	}
}

/**
 * @param {number} l
 * @param {string} c
 * @returns {string}
 */
function indent(l, c) {
	let m = "";

	for (let s of c.split("\n")) {
		if (s) {
			s = `${" ".repeat(l)}${s}`;
		}

		m += `${s}\n`;
	}

	if (m.length !== 0) {
		m = m.slice(0, -1);
	}

	return m;
}

main();
