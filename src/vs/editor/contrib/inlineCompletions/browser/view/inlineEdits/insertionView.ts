/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { $ } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IObservable, constObservable, derived, observableValue } from '../../../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditor } from '../../../../../browser/editorBrowser.js';
import { observableCodeEditor } from '../../../../../browser/observableCodeEditor.js';
import { Point } from '../../../../../browser/point.js';
import { LineSource, renderLines, RenderOptions } from '../../../../../browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { Range } from '../../../../../common/core/range.js';
import { ILanguageService } from '../../../../../common/languages/language.js';
import { LineTokens } from '../../../../../common/tokens/lineTokens.js';
import { TokenArray } from '../../../../../common/tokens/tokenArray.js';
import { GhostText, GhostTextPart } from '../../model/ghostText.js';
import { GhostTextView } from '../ghostText/ghostTextView.js';
import { IInlineEditsView } from './sideBySideDiff.js';
import { createRectangle, mapOutFalsy, n } from './utils.js';

export class InlineEditsInsertionView extends Disposable implements IInlineEditsView {
	private readonly _editorObs = observableCodeEditor(this._editor);

	private readonly _state = derived(this, reader => {
		const state = this._input.read(reader);
		if (!state) { return undefined; }

		const textModel = this._editor.getModel()!;

		if (state.startColumn === 1 && state.lineNumber > 1 && textModel.getLineLength(state.lineNumber) !== 0 && state.text.endsWith('\n') && !state.text.startsWith('\n')) {
			const endOfLineColumn = textModel.getLineLength(state.lineNumber - 1) + 1;
			return { lineNumber: state.lineNumber - 1, column: endOfLineColumn, text: '\n' + state.text.slice(0, -1) };
		}

		return { lineNumber: state.lineNumber, column: state.startColumn, text: state.text };
	});

	private readonly _ghostText = derived<GhostText | undefined>(reader => {
		const state = this._state.read(reader);
		if (!state) { return undefined; }
		return new GhostText(state.lineNumber, [new GhostTextPart(state.column, state.text, false)]);
	});

	protected readonly _ghostTextView = this._register(this._instantiationService.createInstance(GhostTextView,
		this._editor,
		{
			ghostText: this._ghostText,
			minReservedLineCount: constObservable(0),
			targetTextModel: this._editorObs.model.map(model => model ?? undefined),
		},
		observableValue(this, { syntaxHighlightingEnabled: true, extraClasses: ['inline-edit'] }),
	));

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _input: IObservable<{
			lineNumber: number;
			startColumn: number;
			text: string;
		} | undefined>,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super();

		this._register(this._editorObs.createOverlayWidget({
			domNode: this._nonOverflowView.element,
			position: constObservable(null),
			allowEditorOverflow: false,
			minContentWidthInPx: derived(reader => {
				const info = this._editorLayoutInfo.read(reader);
				if (info === null) { return 0; }
				return info.code1.x - info.codeStart1.x;
			}),
		}));
	}

	private readonly _display = derived(this, reader => !!this._state.read(reader) ? 'block' : 'none');

	private readonly _editorMaxContentWidthInRange = derived(this, reader => {
		const state = this._state.read(reader);
		if (!state) {
			return 0;
		}
		this._editorObs.versionId.read(reader);
		const textModel = this._editor.getModel()!;

		const cleanText = state.text.replace('\r\n', '\n');
		const textBeforeInsertion = cleanText.startsWith('\n') ? '' : textModel.getValueInRange(new Range(state.lineNumber, 1, state.lineNumber, state.column));
		const textAfterInsertion = textModel.getValueInRange(new Range(state.lineNumber, state.column, state.lineNumber, textModel.getLineLength(state.lineNumber) + 1));
		const text = textBeforeInsertion + cleanText + textAfterInsertion;
		const lines = text.split('\n');

		const renderOptions = RenderOptions.fromEditor(this._editor).withSetWidth(false);
		const lineWidths = lines.map(line => {
			const t = textModel.tokenization.tokenizeLinesAt(state.lineNumber, [line])?.[0];
			let tokens: LineTokens;
			if (t) {
				tokens = TokenArray.fromLineTokens(t).toLineTokens(line, this._languageService.languageIdCodec);
			} else {
				tokens = LineTokens.createEmpty(line, this._languageService.languageIdCodec);
			}

			return renderLines(new LineSource([tokens]), renderOptions, [], $('div'), true).minWidthInPx - 20; // TODO: always too much padding included, why?
		});

		// Take the max value that we observed.
		// Reset when either the edit changes or the editor text version.
		return Math.max(...lineWidths);
	});

	private readonly _editorLayoutInfo = derived(this, (reader) => {
		this._ghostText.read(reader);
		const state = this._state.read(reader);
		if (!state) {
			return null;
		}

		const editorLayout = this._editorObs.layoutInfo.read(reader);
		const horizontalScrollOffset = this._editorObs.scrollLeft.read(reader);

		const left = editorLayout.contentLeft + this._editorMaxContentWidthInRange.read(reader) - horizontalScrollOffset;

		const scrollTop = this._editorObs.scrollTop.read(reader);

		const top = state.text.startsWith('\n')
			? this._editor.getBottomForLineNumber(state.lineNumber) - scrollTop
			: this._editor.getTopForLineNumber(state.lineNumber) - scrollTop;
		const bottom = this._editor.getTopForLineNumber(state.lineNumber + 1) - scrollTop;

		const codeLeft = editorLayout.contentLeft;

		if (left <= codeLeft) {
			return null;
		}

		const code1 = new Point(left, top);
		const codeStart1 = new Point(codeLeft, top);
		const code2 = new Point(left, bottom);
		const codeStart2 = new Point(codeLeft, bottom);
		const codeHeight = bottom - top;

		return {
			code1,
			codeStart1,
			code2,
			codeStart2,
			codeHeight,
			horizontalScrollOffset,
			padding: 2,
			borderRadius: 4,
		};
	}).recomputeInitiallyAndOnChange(this._store);

	private readonly _foregroundSvg = n.svg({
		transform: 'translate(-0.5 -0.5)',
		style: { overflow: 'visible', pointerEvents: 'none', position: 'absolute' },
	}, derived(reader => {
		const layoutInfoObs = mapOutFalsy(this._editorLayoutInfo).read(reader);
		if (!layoutInfoObs) { return undefined; }

		const layoutInfo = layoutInfoObs.read(reader);

		const rectangleOverlay = createRectangle(
			{
				topLeft: layoutInfo.codeStart1,
				width: layoutInfo.code1.x - layoutInfo.codeStart1.x,
				height: layoutInfo.code2.y - layoutInfo.code1.y,
			},
			layoutInfo.padding,
			layoutInfo.borderRadius,
			{ hideLeft: layoutInfo.horizontalScrollOffset !== 0 }
		);

		return [
			n.svgElem('path', {
				class: 'originalOverlay',
				d: rectangleOverlay,
				style: {
					fill: 'var(--vscode-inlineEdit-modifiedChangedLineBackground, transparent)',
					stroke: 'var(--vscode-inlineEdit-modifiedBorder)',
					strokeWidth: '1px',
				}
			}),
		];
	})).keepUpdated(this._store);

	private readonly _nonOverflowView = n.div({
		class: 'inline-edits-view',
		style: {
			position: 'absolute',
			overflow: 'visible',
			top: '0px',
			left: '0px',
			zIndex: '0',
			display: this._display,
		},
	}, [
		[this._foregroundSvg],
	]).keepUpdated(this._store);

	readonly isHovered = constObservable(false);
}