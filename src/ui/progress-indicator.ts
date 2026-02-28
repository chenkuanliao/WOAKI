export class ProgressIndicator {
	private containerEl: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private progressBar: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private cancelCallback: (() => void) | null = null;
	cancelled = false;

	show(label: string, onCancel?: () => void): void {
		this.hide();
		this.cancelled = false;
		this.cancelCallback = onCancel ?? null;

		this.containerEl = document.body.createDiv("woaki-progress-indicator");
		this.labelEl = this.containerEl.createDiv({ text: label, cls: "woaki-progress-label" });

		const barContainer = this.containerEl.createDiv("woaki-progress-bar-container");
		this.progressBar = barContainer.createDiv("woaki-progress-bar-fill");

		this.countEl = this.containerEl.createDiv({ cls: "woaki-progress-count" });

		if (onCancel) {
			const cancelBtn = this.containerEl.createEl("button", {
				text: "Cancel",
				cls: "woaki-progress-cancel",
			});
			cancelBtn.addEventListener("click", () => {
				this.cancelled = true;
				this.cancelCallback?.();
				this.hide();
			});
		}
	}

	update(current: number, total: number, label?: string): void {
		if (!this.containerEl) return;
		if (label && this.labelEl) this.labelEl.setText(label);
		if (this.countEl) this.countEl.setText(`${current} / ${total}`);
		if (this.progressBar) {
			const pct = total > 0 ? Math.round((current / total) * 100) : 0;
			this.progressBar.style.width = `${pct}%`;
		}
	}

	hide(): void {
		if (this.containerEl) {
			this.containerEl.remove();
			this.containerEl = null;
		}
		this.labelEl = null;
		this.progressBar = null;
		this.countEl = null;
		this.cancelCallback = null;
	}
}
