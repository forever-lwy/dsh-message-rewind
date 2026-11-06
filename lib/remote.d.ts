/** Typert Remote contract shared by the Host service and the browser client. */
import { z } from 'zod';
export declare const targetSchema: z.ZodObject<{
    sessionId: z.ZodString;
    seq: z.ZodNumber;
}, z.core.$strict>;
export type RewindTarget = z.infer<typeof targetSchema>;
export declare const sessionSchema: z.ZodObject<{
    sessionId: z.ZodString;
}, z.core.$strict>;
declare const attachmentSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        image: "image";
        file: "file";
    }>;
    name: z.ZodString;
    bytes: z.ZodNumber;
    mediaType: z.ZodOptional<z.ZodString>;
    available: z.ZodBoolean;
}, z.core.$strip>;
export type RewindAttachmentInfo = z.infer<typeof attachmentSchema>;
/** Workspace edits recorded after the target message; rewinding does not undo them. */
declare const modifiedSchema: z.ZodObject<{
    turns: z.ZodNumber;
    edits: z.ZodNumber;
}, z.core.$strip>;
export type RewindModified = z.infer<typeof modifiedSchema>;
export declare const inspectionSchema: z.ZodObject<{
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    refusal: z.ZodNullable<z.ZodEnum<{
        missing: "missing";
        head: "head";
        "not-user": "not-user";
    }>>;
    text: z.ZodString;
    attachments: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            image: "image";
            file: "file";
        }>;
        name: z.ZodString;
        bytes: z.ZodNumber;
        mediaType: z.ZodOptional<z.ZodString>;
        available: z.ZodBoolean;
    }, z.core.$strip>>;
    modified: z.ZodObject<{
        turns: z.ZodNumber;
        edits: z.ZodNumber;
    }, z.core.$strip>;
    laterMessages: z.ZodNumber;
    running: z.ZodBoolean;
}, z.core.$strip>;
export type RewindInspection = z.infer<typeof inspectionSchema>;
export declare const attachmentRequestSchema: z.ZodObject<{
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    index: z.ZodNumber;
}, z.core.$strict>;
export declare const attachmentDataSchema: z.ZodObject<{
    name: z.ZodString;
    mediaType: z.ZodString;
    data: z.ZodString;
}, z.core.$strip>;
export type RewindAttachmentData = z.infer<typeof attachmentDataSchema>;
/** `knownModified`: the person already saw a warning listing workspace edits. */
export declare const armSchema: z.ZodObject<{
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    knownModified: z.ZodBoolean;
}, z.core.$strict>;
export declare const retrySchema: z.ZodObject<{
    sessionId: z.ZodString;
    seq: z.ZodNumber;
    knownModified: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/** A pending edit: the next human message replaces `seq` and everything after it, up to `lastSeq` at arming. */
declare const armedSchema: z.ZodObject<{
    seq: z.ZodNumber;
    lastSeq: z.ZodNumber;
}, z.core.$strip>;
export type RewindArmed = z.infer<typeof armedSchema>;
export declare const armResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    status: z.ZodLiteral<"armed">;
    armed: z.ZodObject<{
        seq: z.ZodNumber;
        lastSeq: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"confirm">;
    inspection: z.ZodObject<{
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        refusal: z.ZodNullable<z.ZodEnum<{
            missing: "missing";
            head: "head";
            "not-user": "not-user";
        }>>;
        text: z.ZodString;
        attachments: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                image: "image";
                file: "file";
            }>;
            name: z.ZodString;
            bytes: z.ZodNumber;
            mediaType: z.ZodOptional<z.ZodString>;
            available: z.ZodBoolean;
        }, z.core.$strip>>;
        modified: z.ZodObject<{
            turns: z.ZodNumber;
            edits: z.ZodNumber;
        }, z.core.$strip>;
        laterMessages: z.ZodNumber;
        running: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>]>;
export type RewindArmResult = z.infer<typeof armResultSchema>;
export declare const retryResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    status: z.ZodLiteral<"sent">;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"confirm">;
    inspection: z.ZodObject<{
        sessionId: z.ZodString;
        seq: z.ZodNumber;
        refusal: z.ZodNullable<z.ZodEnum<{
            missing: "missing";
            head: "head";
            "not-user": "not-user";
        }>>;
        text: z.ZodString;
        attachments: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                image: "image";
                file: "file";
            }>;
            name: z.ZodString;
            bytes: z.ZodNumber;
            mediaType: z.ZodOptional<z.ZodString>;
            available: z.ZodBoolean;
        }, z.core.$strip>>;
        modified: z.ZodObject<{
            turns: z.ZodNumber;
            edits: z.ZodNumber;
        }, z.core.$strip>;
        laterMessages: z.ZodNumber;
        running: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>]>;
export type RewindRetryResult = z.infer<typeof retryResultSchema>;
export declare const stateSchema: z.ZodObject<{
    armed: z.ZodNullable<z.ZodObject<{
        seq: z.ZodNumber;
        lastSeq: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const remoteInfo: import("@deepseek-ai/dsh-typert-protocol").TypertRemoteInfo<Readonly<Record<string, import("@deepseek-ai/dsh-typert-protocol").TypertRemoteMethod<object, unknown, "unary", never, unknown> | import("@deepseek-ai/dsh-typert-protocol").TypertRemoteMethod<object, unknown, "stream", unknown, unknown>>>>;
/** Browser-side calls bound to one mounted remote. */
export interface RewindRemote {
    inspect(target: RewindTarget, signal?: AbortSignal): Promise<RewindInspection>;
    attachment(request: RewindTarget & {
        index: number;
    }, signal?: AbortSignal): Promise<RewindAttachmentData>;
    arm(request: RewindTarget & {
        knownModified: boolean;
    }, signal?: AbortSignal): Promise<RewindArmResult>;
    disarm(request: {
        sessionId: string;
    }, signal?: AbortSignal): Promise<{
        ok: true;
    }>;
    retry(request: RewindTarget & {
        knownModified: boolean;
        note: string | null;
    }, signal?: AbortSignal): Promise<RewindRetryResult>;
    state(request: {
        sessionId: string;
    }, signal?: AbortSignal): Promise<{
        armed: RewindArmed | null;
    }>;
}
export declare function bindRemote(remote: unknown): RewindRemote;
export {};
