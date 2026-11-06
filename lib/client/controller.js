const errorMessage = (error) => error instanceof Error ? error.message : String(error);
function decode(data, kind) {
    const binary = atob(data.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
        bytes[index] = binary.charCodeAt(index);
    return new File([bytes], data.name, { type: kind === 'image' ? data.mediaType : (data.mediaType === 'application/octet-stream' ? '' : data.mediaType) });
}
export class RewindController {
    deps;
    /** One rewind at a time per Session. */
    busy = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    isRunning(sessionId) {
        return this.deps.sessions.list.getSnapshot().byId[sessionId]?.running === true;
    }
    inspect(sessionId, seq) {
        return this.deps.remote.inspect({ sessionId, seq });
    }
    /**
     * Rewind `sessionId` to just before message `info.seq`.
     * @param sessionId - Session to rewind.
     * @param info - inspection returned by {@link inspect}.
     * @param mode - edit returns the message to the composer; retry sends it again.
     * @param options - warning acknowledgement and the optional note.
     */
    async run(sessionId, info, mode, options) {
        if (this.busy.has(sessionId))
            throw new Error('rewind already in progress');
        this.busy.add(sessionId);
        try {
            return mode === 'retry' ? await this.retry(sessionId, info, options) : await this.edit(sessionId, info, options);
        }
        finally {
            this.busy.delete(sessionId);
        }
    }
    /** Withdraw a pending edit; the transcript shows the message again. */
    async undo(sessionId) {
        await this.deps.remote.disarm({ sessionId });
        this.deps.feed(sessionId)?.setArmed(null);
    }
    async retry(sessionId, info, options) {
        const result = await this.deps.remote.retry({ sessionId, seq: info.seq, knownModified: options.knownModified, note: options.note });
        return result.status === 'confirm' ? result : { status: 'done', notices: [] };
    }
    async edit(sessionId, info, options) {
        const { remote, sessions, conversation } = this.deps;
        const notices = [];
        // Read attachments before anything changes, so a failure here aborts cleanly.
        const files = [];
        for (const [index, attachment] of info.attachments.entries()) {
            if (!attachment.available) {
                notices.push({ key: 'attachmentFailed', values: { name: attachment.name, message: 'too large' } });
                continue;
            }
            try {
                files.push(decode(await remote.attachment({ sessionId, seq: info.seq, index }), attachment.kind));
            }
            catch (error) {
                notices.push({ key: 'attachmentFailed', values: { name: attachment.name, message: errorMessage(error) } });
            }
        }
        const result = await remote.arm({ sessionId, seq: info.seq, knownModified: options.knownModified });
        if (result.status === 'confirm')
            return result;
        this.deps.feed(sessionId)?.setArmed(result.armed);
        const scope = sessions.scope(sessionId);
        if (scope === undefined)
            throw new Error('session not open');
        const input = conversation.input.for(scope);
        input.setDraft(options.note ? `${info.text}\n\n${options.note}` : info.text);
        const drafts = files.length > 0 ? conversation.createDrafts(sessionId, files) : [];
        if (drafts.length > 0 && !input.addAttachments(drafts.map(draft => draft.id))) {
            notices.push({ key: 'attachmentFailed', values: { name: files.map(file => file.name).join(', '), message: 'composer refused' } });
        }
        input.focus?.();
        return { status: 'done', notices };
    }
}
