import { Container } from "@earendil-works/pi-tui";

/** Owns the whole-transcript reset boundary, not individual component disposal. */
export class TranscriptContainer extends Container {
	private resetListeners = new Set<{ handler: () => void }>();
	private onError: (error: unknown) => void;

	constructor(onError: (error: unknown) => void) {
		super();
		this.onError = onError;
	}

	onReset(handler: () => void): () => void {
		const subscription = { handler };
		this.resetListeners.add(subscription);
		return () => {
			this.resetListeners.delete(subscription);
		};
	}

	clearResetListeners(): void {
		this.resetListeners.clear();
	}

	override clear(): void {
		super.clear();
		for (const subscription of [...this.resetListeners]) {
			if (!this.resetListeners.has(subscription)) continue;
			try {
				// Cleanup must finish synchronously. Catch accidental async rejections without waiting for them.
				void Promise.resolve(subscription.handler()).catch(this.onError);
			} catch (error) {
				this.onError(error);
			}
		}
	}
}
