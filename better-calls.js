// BetterCalls -> Revenge Next (plain JS port, single file)
//
// Everything marked GUESS is an API I could not verify. They are ALL in the
// ADAPTERS block below, so that's the only place you should need to fix.

/* ============================ ADAPTERS (GUESS) ============================ */
const React = revenge.modules.common.React; // GUESS
const RN = revenge.modules.common.ReactNative; // GUESS
const { findByProps, findByTypeName } = revenge.modules.finders; // GUESS
const C = revenge.components; // GUESS: needs Stack, TableRow, TableRowGroup, TableSwitchRow,
//        TableRadioGroup, TableRadioRow, Text, IconButton, ActionSheet,
//        BottomSheetTitleHeader, ErrorBoundary
const findAssetId = (name) => revenge.assets.getIdByName(name); // GUESS
const showToast = (content, icon) =>
	revenge.discord.toasts.open({ key: "better-calls:toast", content, icon }); // GUESS
const showSheet = (key, render) => revenge.discord.sheets.show(key, render); // GUESS
/* ========================================================================== */

const h = React.createElement;

/* ------------------------------ tiny patcher ------------------------------ */
// Own implementation so we don't depend on Next's patcher API.
// NOTE: if a module's exports are frozen/non-writable this will silently fail.
function patchMethod(obj, name, make) {
	const orig = obj[name];
	obj[name] = make(orig);
	return () => {
		obj[name] = orig;
	};
}

// cb(args, returnValue) -> return a value to replace the result
const after = (obj, name, cb) =>
	patchMethod(obj, name, (orig) =>
		function (...args) {
			const ret = orig.apply(this, args);
			const out = cb(args, ret);
			return out === undefined ? ret : out;
		},
	);

// cb(args, originalFn, thisArg) -> you decide whether to call the original
const instead = (obj, name, cb) =>
	patchMethod(obj, name, (orig) =>
		function (...args) {
			return cb(args, orig, this);
		},
	);

/* -------------------------------- storage --------------------------------- */
const DEFAULTS = {
	silentCall: { enabled: true, default: false, users: {} },
	rememberOutputDevice: { enabled: false, device: undefined },
};

function createStorage(raw) {
	for (const k of Object.keys(DEFAULTS)) {
		if (raw[k] === undefined) raw[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
	}
	const walk = (path) => path.split(".");
	return {
		get: (path) => walk(path).reduce((o, k) => o?.[k], raw),
		set(path, value) {
			const keys = walk(path);
			const last = keys.pop();
			const parent = keys.reduce((o, k) => (o[k] ??= {}), raw);
			parent[last] = value;
			return true;
		},
		unset(path) {
			const keys = walk(path);
			const last = keys.pop();
			const parent = keys.reduce((o, k) => o?.[k], raw);
			if (parent) delete parent[last];
			return true;
		},
		getFirstDefined(...paths) {
			for (const p of paths) {
				const v = this.get(p);
				if (v !== undefined) return v;
			}
		},
	};
}

let storage; // set in start()
let audio; // set in start()
let unpatches = { silentCall: [], rememberOutputDevice: [] };

/* --------------------------- audio device helpers -------------------------- */
function createAudio() {
	const { getAudioDevices } = findByProps("getAudioDevices");
	const { setAudioOutputDevice } = findByProps("setAudioOutputDevice");
	const { audioDeviceToIconMap, getAudioDeviceToDisplayText } = findByProps("audioDeviceToIconMap");
	return {
		getAudioDevices: () => getAudioDevices(),
		setAudioOutputDevice: (d) => setAudioOutputDevice(d),
		getAudioDeviceIcon: (type) => audioDeviceToIconMap[type],
		getAudioDeviceDisplayText: (d) => getAudioDeviceToDisplayText(d),
	};
}

function showAudioOutputDevicesSelectionSheet(props) {
	showSheet("better-calls:audio-output-devices-select", () =>
		h(C.ErrorBoundary, null, h(AudioOutputDevicesSelectionSheet, props)),
	);
}

/* ------------------------------ silent call patch ------------------------- */
const NextPreference = { undefined: true, true: false, false: undefined };

const Preferences = {
	undefined: {
		icon: "BellIcon",
		description: "Following the global setting for this user",
		buttonVariant: "tertiary",
		action: (cid) => storage.unset(`silentCall.users.${cid}`),
	},
	true: {
		icon: "BellZIcon",
		description: "Calling will now silently call this user",
		buttonVariant: "primary",
		action: (cid) => storage.set(`silentCall.users.${cid}`, true),
	},
	false: {
		icon: "ic_notification_settings_24px",
		description: "Calling will now ring this user",
		buttonVariant: "secondary",
		action: (cid) => storage.set(`silentCall.users.${cid}`, false),
	},
};

function patchSilentCall(out) {
	const callModule = findByProps("call", "ring", "stopRinging");
	const PrivateChannelButtons = findByTypeName("PrivateChannelButtons");
	if (!callModule || !PrivateChannelButtons) return; // fail silently like the original

	// Structure: <PrivateChannelButtons><Fragment><IconButton/>...
	out.push(
		after(PrivateChannelButtons, "type", ([{ channelId }], rt) => {
			// hooks are fine here, we're running inside the component's render
			const [silenced, setSilenced] = React.useState(storage.get(`silentCall.users.${channelId}`));

			const key = String(silenced);
			const pref = Preferences[key];
			const fragmentProps = rt?.props?.children?.[0]?.props;

			// Can be undefined while in a call (buttons are replaced by hang up). Bot DMs give an object.
			if (Array.isArray(fragmentProps?.children)) {
				fragmentProps.children = [
					h(C.IconButton, {
						key: "better-calls:silent-call-toggle",
						icon: findAssetId(pref.icon),
						variant: pref.buttonVariant,
						size: "sm",
						onPress: () => {
							const next = NextPreference[key];
							setSilenced(next);
							const nextPref = Preferences[String(next)];
							nextPref.action(channelId);
							showToast(nextPref.description, findAssetId(nextPref.icon));
						},
					}),
					...fragmentProps.children,
				];
			}
		}),
	);

	out.push(
		instead(callModule, "ring", (args, ring, self) => {
			const silent = storage.getFirstDefined(`silentCall.users.${args[0]}`, "silentCall.default");
			if (!silent) return ring.apply(self, args);
		}),
	);
}

/* ------------------------ remember output device patch -------------------- */
function patchRememberOutputDevice(out) {
	const VoicePanelHeaderSpeaker = findByTypeName("VoicePanelHeaderSpeaker");
	if (!VoicePanelHeaderSpeaker) return;

	out.push(
		after(VoicePanelHeaderSpeaker, "type", ([props]) => {
			if (!props.isConnectedToVoiceChannel) return;
			const device = storage.get("rememberOutputDevice.device");
			if (!device) return; // guard added: original would crash here with no device

			// Same as the original: re-applies the saved device on every render while connected
			audio.setAudioOutputDevice(device);

			return h(C.IconButton, {
				key: "better-calls:output-device-button",
				icon: audio.getAudioDeviceIcon(device.simpleDeviceType),
				variant: "primary-overlay",
				size: "sm",
				onPress: () => showAudioOutputDevicesSelectionSheet({ fromVoiceCall: true }),
			});
		}),
	);
}

/* ---------------------------- patch lifecycle ------------------------------ */
function clear(key) {
	for (const u of unpatches[key]) u();
	unpatches[key] = [];
}

function syncPatches() {
	const devices = audio.getAudioDevices();
	const cur = storage.get("rememberOutputDevice.device");
	// Reset if nothing saved or the saved device is gone
	if (!cur || !devices.some((d) => d.deviceId === cur.deviceId && d.deviceType === cur.deviceType)) {
		storage.set("rememberOutputDevice.device", devices[0]);
	}

	if (!storage.get("silentCall.enabled")) clear("silentCall");
	else if (!unpatches.silentCall.length) patchSilentCall(unpatches.silentCall);

	if (!storage.get("rememberOutputDevice.enabled")) clear("rememberOutputDevice");
	else if (!unpatches.rememberOutputDevice.length) patchRememberOutputDevice(unpatches.rememberOutputDevice);
}

/* -------------------------------- UI: sheet -------------------------------- */
function AudioOutputDevicesSelectionSheet({ onPress, fromVoiceCall }) {
	const devices = audio.getAudioDevices();

	return h(
		C.ActionSheet,
		null,
		h(
			RN.View,
			null,
			h(
				C.Stack,
				{ spacing: 16 },
				h(C.BottomSheetTitleHeader, { title: "Select Preferred Audio Output Device" }),
				h(
					C.Stack,
					{ spacing: 12 },
					h(
						C.TableRadioGroup,
						{
							title: "Audio Devices",
							hasIcons: true,
							value: storage.get("rememberOutputDevice.device.deviceId"),
							onChange: (deviceId) => {
								const device = devices.find((d) => d.deviceId === deviceId);
								if (!device) return;
								storage.set("rememberOutputDevice.device", device);
								audio.setAudioOutputDevice(device);
								if (onPress) onPress();
							},
						},
						devices.map((device) =>
							h(C.TableRadioRow, {
								key: String(device.deviceId),
								icon: h(C.TableRow.Icon, { source: audio.getAudioDeviceIcon(device.simpleDeviceType) }),
								label: audio.getAudioDeviceDisplayText(device),
								subLabel: device.deviceName,
								value: device.deviceId,
							}),
						),
					),
				),
				fromVoiceCall &&
					h(
						C.Stack,
						{ spacing: 0 },
						h(
							C.Text,
							{ variant: "text-xs/normal", color: "TEXT_MUTED" },
							"Missing a few devices from the stock panel? Swipe up the dock and use ",
							h(C.Text, { variant: "text-xs/bold" }, "Change Audio Output"),
							".",
						),
					),
			),
		),
	);
}

/* ------------------------------ UI: settings ------------------------------- */
function SettingsPage() {
	const [, forceUpdate] = React.useReducer((x) => ~x, 0);
	const onUpdate = () => {
		syncPatches();
		forceUpdate();
	};
	const muted = { variant: "text-xs/normal", color: "TEXT_MUTED" };
	const device = storage.get("rememberOutputDevice.device");

	return h(
		C.ErrorBoundary,
		null,
		h(
			RN.ScrollView,
			{ style: { flex: 1 }, contentContainerStyle: { paddingBottom: 38 } },
			h(
				C.Stack,
				{ style: { paddingVertical: 24, paddingHorizontal: 12 }, spacing: 24 },

				// ---- Silent Call ----
				h(
					C.Stack,
					{ spacing: 12 },
					h(
						C.TableRowGroup,
						{ title: "Silent Call" },
						h(C.TableSwitchRow, {
							icon: h(C.TableRow.Icon, { source: findAssetId("ic_notif_off") }),
							label: "Enable Silent Call",
							subLabel: "Silently call someone without ringing, configurable per user.",
							value: storage.get("silentCall.enabled"),
							onValueChange: (v) => {
								storage.set("silentCall.enabled", v);
								onUpdate();
							},
						}),
						h(C.TableSwitchRow, {
							icon: h(C.TableRow.Icon, { source: findAssetId("ic_call_ended") }),
							label: "Ring by default",
							subLabel: "Ring people by default unless you set otherwise. This will affect unset preferences.",
							value: !storage.get("silentCall.default"),
							onValueChange: (v) => {
								storage.set("silentCall.default", !v);
								onUpdate();
							},
						}),
						h(C.TableRow, {
							variant: "danger",
							icon: h(C.TableRow.Icon, { variant: "danger", source: findAssetId("ic_message_delete") }),
							label: "Reset preferences",
							subLabel: "Reset all silent call preferences, this will make you ring people by default again.",
							onPress: () => {
								storage.set("silentCall.users", {});
								showToast("Silent call preferences have been reset", findAssetId("ic_message_delete"));
							},
						}),
					),
					h(
						C.Text,
						muted,
						"You may need to switch between DMs and servers for the changes to take effect. This is because Discord caches rendered components.",
					),
				),

				// ---- Remember Audio Output Device ----
				h(
					C.Stack,
					{ spacing: 12 },
					h(
						C.TableRowGroup,
						{ title: "Remember Audio Output Device" },
						h(C.TableSwitchRow, {
							icon: h(C.TableRow.Icon, { source: findAssetId("voice_bar_speaker_new") }),
							label: "Remember audio output device",
							subLabel: "Remembers your audio output device preferences.",
							value: storage.get("rememberOutputDevice.enabled"),
							onValueChange: (v) => {
								storage.set("rememberOutputDevice.enabled", v);
								onUpdate();
							},
						}),
						h(C.TableRow, {
							disabled: !storage.get("rememberOutputDevice.enabled"),
							icon: h(C.TableRow.Icon, {
								source: audio.getAudioDeviceIcon(device?.simpleDeviceType ?? "INVALID"),
							}),
							label: "Current device",
							subLabel: device
								? `${device.deviceName} - ${audio.getAudioDeviceDisplayText(device)}`
								: "No device",
							arrow: true,
							onPress: () => showAudioOutputDevicesSelectionSheet({ onPress: forceUpdate }),
						}),
					),
					h(
						C.Text,
						muted,
						"If your device is not persistent, the first device will be selected after the preferred device is removed.",
					),
					h(
						C.Text,
						muted,
						"This also replaces the audio output device selection sheet, so it may be missing features such as transferring voice chats to a console. Alternatively, swipe up the dock in the voice call UI and use ",
						h(C.Text, { variant: "text-xs/bold" }, "Change Audio Output"),
						".",
					),
				),
			),
		),
	);
}

/* --------------------------------- plugin ---------------------------------- */
export default plugin({
	// GUESS: how Next hands you persisted storage. If it's not in the context,
	// find where plugin storage lives and pass that object to createStorage().
	start({ cleanup, storage: rawStorage }) {
		storage = createStorage(rawStorage ?? {});
		audio = createAudio();
		syncPatches();
		cleanup(() => {
			clear("silentCall");
			clear("rememberOutputDevice");
		});
	},

	// GUESS: how Next registers a settings page
	settings: SettingsPage,
});
