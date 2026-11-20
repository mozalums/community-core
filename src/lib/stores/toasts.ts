import { writable } from 'svelte/store';
import { shortId } from '$lib/utils/short-id';

export type ToastType = 'success' | 'error' | 'info' | 'warn' | 'neutral';

export type Toast = {
	id: string;
	msg: string;
	type: ToastType;
	duration?: number;
};

export const toasts = writable<Toast[]>([]);

export function addToast(input: { msg: string; type?: ToastType; duration?: number }): string {
	const id = shortId();
	const toast: Toast = {
		id,
		msg: input.msg,
		type: input.type ?? 'neutral',
		duration: input.duration ?? 4000
	};
	toasts.update((s) => [toast, ...s]);
	if (toast.duration && toast.duration > 0) {
		setTimeout(() => dismissToast(id), toast.duration);
	}
	return id;
}

export function dismissToast(id: string) {
	toasts.update((s) => s.filter((t) => t.id !== id));
}
