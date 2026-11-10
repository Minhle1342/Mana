import { CloseIcon, RedoIcon } from "@p2/app/v1/web";

export function RevertBar({
	revertId,
	added,
	deleted,
	onRevert,
	onDismiss,
}: {
	revertId: string;
	added: number;
	deleted: number;
	onRevert: (revertId: string) => Promise<void> | void;
	onDismiss: (revertId: string) => void;
}) {
	return (
		<div className="revert-banner">
			<button
				type="button"
				className="revert-banner-button"
				onClick={() => void onRevert(revertId)}
				title="Click to revert undone code changes"
			>
				<span className="revert-banner-icon">
					<RedoIcon />
				</span>
				<span className="revert-banner-label">Revert code changes:</span>
				<span className="diff-badge add" title="Code lines that will be restored">
					+{added}
				</span>
				<span className="diff-badge del" title="Code lines that will be removed">
					-{deleted}
				</span>
			</button>
			<button
				type="button"
				className="revert-banner-close"
				aria-label="Dismiss revert banner"
				onClick={() => onDismiss(revertId)}
			>
				<CloseIcon />
			</button>
		</div>
	);
}
