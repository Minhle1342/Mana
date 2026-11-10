import { Sheet } from "@p2/app/v1/web";
import { useState } from "react";

export function UndoModal({
	entryId,
	diff,
	loading,
	error,
	onConfirm,
	onClose,
}: {
	entryId: number;
	diff?: { hasCheckpoint: boolean; added: number; deleted: number };
	loading?: boolean;
	error?: string;
	onConfirm: (entryId: number) => Promise<void>;
	onClose: () => void;
}) {
	const [submitting, setSubmitting] = useState(false);
	const handleConfirm = async () => {
		if (submitting) return;
		setSubmitting(true);
		try {
			await onConfirm(entryId);
			onClose();
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Sheet title="Undo Checkpoint" onClose={onClose} className="undo-modal">
			<div className="stack">
				{loading ? (
					<p className="muted">Calculating checkpoint changes…</p>
				) : error ? (
					<p className="error-text">{error}</p>
				) : diff && !diff.hasCheckpoint ? (
					<p className="muted">No checkpoint found before this message.</p>
				) : (
					<>
						<p>Undo code changes to the checkpoint before this message?</p>
						<div className="undo-modal-diff">
							<span className="diff-badge add" title="Code lines to be restored upon undo">
								+{diff?.added ?? 0}
							</span>
							<span className="diff-badge del" title="Code lines to be lost upon undo">
								-{diff?.deleted ?? 0}
							</span>
						</div>
						<div className="button-row">
							<button type="button" className="button round" onClick={onClose} disabled={submitting}>
								Cancel
							</button>
							<button
								type="button"
								className="button round primary"
								onClick={() => void handleConfirm()}
								disabled={submitting || loading}
							>
								{submitting ? "Undoing…" : "Yes"}
							</button>
						</div>
					</>
				)}
			</div>
		</Sheet>
	);
}
