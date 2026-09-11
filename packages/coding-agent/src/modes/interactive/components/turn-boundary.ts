import { Container, Spacer } from "@earendil-works/pi-tui";
import type {
	SessionMessageRenderContext,
	TurnBoundaryContext,
	TurnBoundaryRenderer,
	TurnBoundaryRendererTransform,
} from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { composeTurnBoundaryRenderer } from "./turn-boundary-renderer.ts";

/** A user boundary keeps its renderer lifetime while its message becomes persisted. */
export class TurnBoundaryComponent extends Container {
	private context: TurnBoundaryContext;
	private renderer: TurnBoundaryRenderer;

	constructor(context: TurnBoundaryContext, transforms: readonly TurnBoundaryRendererTransform[]) {
		super();
		this.context = context;
		this.renderer = composeTurnBoundaryRenderer(() => new Spacer(1), transforms);
		this.rebuild();
	}

	setRenderContext(renderContext: SessionMessageRenderContext): void {
		this.context = { ...this.context, renderContext };
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(this.renderer(this.context, theme));
	}
}
