/**
 * The Strategy:
 *
 * 1. parse out the <template>...</template> regions
 *    - we haven't shipped "content-tag" through TC39, so for now, gjs and gts are invalid JavaScript
 *
 * 2. create a new string/contents of the file with a placeholder for the template regisions
 *    - this will be used later to splice in the Template AST Nodes
 *    - the placeholder should be the same dimensions as the template region
 *
 * 3. parse the string/contents as js/ts to generate an ESTree
 *
 * 4. parse each template region to generate an AST from that
 *
 * 5. convert the AST from `@glimmer/syntax` to ESTree
 *    - NOTE: it may already be ESTree
 *
 * 6. splice in the template ESTrees into the JS/TS ESTree
 *
 * 7. Done
 */

/**
 * Docs for dependencies:
 * - https://github.com/embroider-build/content-tag/
 */

import { parseSync } from "oxc-parser";
import { Preprocessor } from "content-tag";
import { walk } from "zimmerframe";

import { DocumentLines, processGlimmerTemplateFromSource } from "./transforms.js";

const preprocessor = new Preprocessor();

/**
 * @param {string} source
 * @param {object} options
 * @return {object} A File-like AST with a `.program` property
 */
export function toTree(source, options = {}) {
  let parseResults = preprocessor.parse(source);
  let js = toPlaceholderJS(source, parseResults);

  let filename = options.filePath || "input.ts";
  let oxcResult = parseSync(filename, js);

  // Wrap in a File-like node to match the expected structure
  let outerAST = {
    type: "File",
    program: oxcResult.program,
    comments: oxcResult.comments || [],
    start: oxcResult.program.start,
    end: oxcResult.program.end,
  };

  // content-tag v4 provides UTF-16 codepoint offsets that match
  // JavaScript string indices and oxc-parser character offsets directly,
  // so no byte-to-character conversion is needed.
  const docLines = new DocumentLines(source);
  outerAST = walk(outerAST, null, {
    _(node, { next }) {
      if (isExpressionPlaceholder(node) || isClassMemberPlaceholder(node)) {
        let parseResult = parseResults.find((r) => {
          return (
            node.start === r.range.startUtf16Codepoint && node.end === r.range.endUtf16Codepoint
          );
        });

        return processGlimmerTemplateFromSource(parseResult.contents, {
          contentOffset: parseResult.contentRange.startUtf16Codepoint,
          templateRange: [
            parseResult.range.startUtf16Codepoint,
            parseResult.range.endUtf16Codepoint,
          ],
          source,
        });
      }

      // Ensure all nodes have `range` and `loc` (oxc-parser only sets start/end).
      // Glimmer nodes already have these from processGlimmerTemplate.
      if (typeof node.start === "number" && typeof node.end === "number") {
        if (!node.range) {
          node.range = [node.start, node.end];
        }
        if (!node.loc) {
          node.loc = {
            start: docLines.offsetToPosition(node.start),
            end: docLines.offsetToPosition(node.end),
          };
        }
      }
      next();
    },
  });

  return outerAST;
}

/**
 * Parse Ember .gjs/.gts source code into an ESTree-compatible AST
 * with embedded Glimmer template nodes.
 *
 * @param {string} source - The source code to parse
 * @param {object} [options] - Parse options
 * @return {object} The ESTree-compatible AST
 */
export function parse(source, options = {}) {
  let ast = toTree(source, options);

  return ast;
}

//////////////////////////////////////////////////
//
// Helpers
//
//////////////////////////////////////////////////

function isExpressionPlaceholder(node) {
  if (node.type !== "CallExpression") return;

  return node.callee.name === "TEMPLATE_TEMPLATE";
}

function isClassMemberPlaceholder(node) {
  if (node.type !== "PropertyDefinition") return;

  return (
    node.computed && node.key?.type === "CallExpression" && node.key.callee?.name === "_TEMPLATE_"
  );
}

/**
 * Replaces <template>...</template> regions in source with
 * placeholder expressions of the same character length that
 * are valid JavaScript, so oxc-parser can parse them.
 *
 * Expression templates become:  TEMPLATE_TEMPLATE(`...`)
 * Class member templates become: [_TEMPLATE_(`...`)] = 0;
 *
 * Both placeholder forms use exactly 21 characters for the
 * opening + closing wrappers, matching the original
 * <template> (10) + </template> (11) = 21 character overhead.
 *
 * @param {string} source
 * @param {Array<object>} parseResults
 * @returns {string}
 */
function toPlaceholderJS(source, parseResults) {
  let result = source;
  let offset = 0;

  for (let pr of parseResults) {
    let start = pr.range.startUtf16Codepoint;
    let end = pr.range.endUtf16Codepoint;

    let openingTag, closingTag;
    switch (pr.type) {
      case "expression":
        openingTag = "TEMPLATE_TEMPLATE(`";
        closingTag = "`)";
        break;
      case "class-member":
        openingTag = "[_TEMPLATE_(`";
        closingTag = "`)] = 0;";
        break;
    }

    let content = source.slice(
      pr.contentRange.startUtf16Codepoint,
      pr.contentRange.endUtf16Codepoint,
    );

    let replacement = openingTag + content + closingTag;

    result = result.slice(0, start + offset) + replacement + result.slice(end + offset);
    offset += replacement.length - (end - start);
  }

  return result;
}
