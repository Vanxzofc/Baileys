/**
 * @file make-in-memory-store.js
 * @version 2.0.0
 * @description
 * Versi canggih dari Baileys In-Memory Store dengan fokus pada Kinerja, Ketahanan, dan Keterbacaan.
 *
 * Peningkatan Utama:
 * - Manajemen Error Proaktif dengan try-catch untuk mencegah crash.
 * - Memoization untuk optimasi pemanggilan fungsi berulang.
 * - Penggunaan sintaks JavaScript modern (ES2020+) untuk kode yang lebih bersih.
 * - Perbaikan bug kritis dan optimasi mikro pada event handler.
 * - Dokumentasi JSDoc profesional untuk kemudahan pemeliharaan.
 */
"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const { writeFileSync, readFileSync, existsSync } = require('fs')
const { proto: WAProto } = require("../../WAProto")
const { DEFAULT_CONNECTION_CONFIG: Defaults } = require("../Defaults")
const { LabelAssociationType } = require("../Types/LabelAssociation")
const Utils = require("../Utils")
const { jidDecode, jidNormalizedUser } = require("../WABinary")
const { makeOrderedDictionary } = require("./make-ordered-dictionary")
const { ObjectRepository } = require("./object-repository")
const KeyedDB = require('@adiwajshing/keyed-db').default

/**
 * Membuat fungsi memoize sederhana untuk caching hasil fungsi.
 * @template T
 * @param {(...args: any[]) => T} func Fungsi yang akan di-memoize.
 * @returns {(...args: any[]) => T} Versi memoized dari fungsi.
 */
const memoize = (func) => {
	const cache = new Map()
	return (...args) => {
		const key = JSON.stringify(args)
		if (cache.has(key)) {
			return cache.get(key)
		}
		const result = func(...args)
		cache.set(key, result)
		return result
	}
}

const memoizedJidNormalizedUser = memoize(jidNormalizedUser)

const waChatKey = (pin) => ({
	key: (c) => (pin ? (c.pinned ? '1' : '0') : '') + (c.archived ? '0' : '1') + (c.conversationTimestamp ? c.conversationTimestamp.toString(16).padStart(8, '0') : '') + c.id,
	compare: (k1, k2) => k2.localeCompare(k1),
})

const waMessageID = (m) => m.key.id || ''

const waLabelAssociationKey = {
	key: (la) => (la.type === LabelAssociationType.Chat ? la.chatId + la.labelId : la.chatId + la.messageId + la.labelId),
	compare: (k1, k2) => k2.localeCompare(k1),
}

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID)

/**
 * Membuat instance store yang menyimpan data bot di memori (RAM).
 * @param {import('../Types').BaileysInMemoryStoreConfig} config Konfigurasi store.
 * @returns {import('../Types').BaileysEventEmitter}
 */
const makeInMemoryStore = (config) => {
	const socket = config.socket
	const chatKey = config.chatKey || waChatKey(true)
	const labelAssociationKey = config.labelAssociationKey || waLabelAssociationKey
	const logger = config.logger || Defaults.logger.child({ stream: 'in-mem-store' })

	const chats = new KeyedDB(chatKey, c => c.id)
	const messages = {}
	const contacts = {}
	const groupMetadata = {}
	const presences = {}
	const state = { connection: 'close' }
	const labels = new ObjectRepository()
	const labelAssociations = new KeyedDB(labelAssociationKey, labelAssociationKey.key)

	const assertMessageList = (jid) => {
		if (!messages[jid]) {
			messages[jid] = makeMessagesDictionary()
		}
		return messages[jid]
	}

	const contactsUpsert = (newContacts) => {
		const oldContacts = new Set(Object.keys(contacts))
		for (const contact of newContacts) {
			if (!contact.id) continue
			oldContacts.delete(contact.id)
			contacts[contact.id] = { ...(contacts[contact.id] || {}), ...contact }
		}
		return oldContacts
	}

	const labelsUpsert = (newLabels) => {
		for (const label of newLabels) {
			labels.upsertById(label.id, label)
		}
	}

	const bind = (ev) => {
		ev.on('connection.update', update => {
			Object.assign(state, update)
		})

		ev.on('messaging-history.set', ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest, syncType }) => {
			try {
				if (syncType === WAProto.HistorySync.HistorySyncType.ON_DEMAND) {
					for (const msg of newMessages) {
						const jid = msg.key.remoteJid
						assertMessageList(jid).upsert(msg, 'prepend')
					}
					logger.debug({ messages: newMessages.length }, 'on-demand sync: merged messages')
					return
				}

				if (isLatest) {
					chats.clear()
					Object.keys(messages).forEach(key => delete messages[key])
				}

				chats.insertIfAbsent(...newChats)
				logger.debug({ chatsAdded: newChats.length }, 'synced chats')

				const oldContacts = contactsUpsert(newContacts)
				if (isLatest) {
					for (const jid of oldContacts) {
						delete contacts[jid]
					}
				}
				logger.debug({ deletedContacts: isLatest ? oldContacts.size : 0, newContacts: newContacts.length }, 'synced contacts')

				for (const msg of newMessages) {
					const jid = msg.key.remoteJid
					assertMessageList(jid).upsert(msg, 'prepend')
				}
				logger.debug({ messages: newMessages.length }, 'synced messages')
			} catch (error) {
				logger.error({ err: error }, 'Error processing messaging-history.set')
			}
		})

		ev.on('contacts.upsert', newContacts => {
			contactsUpsert(newContacts)
		})

		ev.on('contacts.update', async (updates) => {
			for (const update of updates) {
				try {
					let contact
					if (contacts[update.id]) {
						contact = contacts[update.id]
					} else {
						// Fallback logic untuk menemukan kontak jika ID tidak cocok langsung
						const contactHashes = await Promise.all(
							Object.keys(contacts).map(async (contactId) => {
								const { user } = jidDecode(contactId)
								const hash = (await Utils.md5(Buffer.from(user + 'WA_ADD_NOTIF', 'utf8'))).toString('base64').slice(0, 3)
								return [contactId, hash]
							})
						)
						const foundId = contactHashes.find(([, b]) => b === update.id?.[0])?.[0]
						contact = foundId ? contacts[foundId] : undefined
					}

					if (!contact?.id) {
						return logger.debug({ update }, 'got update for non-existent contact')
					}
					
					if (update.imgUrl === 'changed') {
						contact.imgUrl = await socket?.profilePictureUrl(contact.id, 'image').catch(() => undefined)
					} else if (update.imgUrl === 'removed') {
						delete contact.imgUrl
					}

					Object.assign(contacts[contact.id], contact)
				} catch (error) {
					logger.error({ err: error, update }, 'Error processing contacts.update')
				}
			}
		})

		ev.on('chats.upsert', newChats => {
			chats.upsert(...newChats)
		})

		ev.on('chats.update', updates => {
			for (let update of updates) {
				const result = chats.update(update.id, chat => {
					if (update.unreadCount && update.unreadCount > 0) {
						update = { ...update }
						// Gunakan Nullish Coalescing untuk keamanan
						update.unreadCount = (chat.unreadCount ?? 0) + update.unreadCount
					}
					Object.assign(chat, update)
				})
				if (!result) {
					logger.debug({ update }, 'got update for non-existent chat')
				}
			}
		})

		ev.on('presence.update', ({ id, presences: update }) => {
			presences[id] = { ...(presences[id] || {}), ...update }
		})

		ev.on('chats.delete', deletions => {
			for (const id of deletions) {
				if (chats.get(id)) {
					chats.deleteById(id)
				}
			}
		})

		ev.on('messages.upsert', ({ messages: newMessages, type }) => {
			if (type === 'append' || type === 'notify') {
				for (const msg of newMessages) {
					const jid = memoizedJidNormalizedUser(msg.key.remoteJid)
					assertMessageList(jid).upsert(msg, 'append')

					if (type === 'notify' && !chats.get(jid)) {
						ev.emit('chats.upsert', [{
							id: jid,
							conversationTimestamp: Utils.toNumber(msg.messageTimestamp),
							unreadCount: 1,
						}])
					}
				}
			}
		})

		ev.on('messages.update', updates => {
			for (const { key, update } of updates) {
				try {
					const jid = memoizedJidNormalizedUser(key.remoteJid)
					const list = assertMessageList(jid)

					if (update?.status) {
						const currentStatus = list.get(key.id)?.status
						if (currentStatus && update.status <= currentStatus) {
							logger.debug({ update, storedStatus: currentStatus }, 'status stored is newer than update, skipping')
							delete update.status
						}
					}
					
					if(Object.keys(update).length === 0) continue

					const result = list.updateAssign(key.id, update)
					if (!result) {
						logger.debug({ update }, 'got update for non-existent message')
					}
				} catch (error) {
					logger.error({ err: error, update }, 'Error processing messages.update')
				}
			}
		})

		ev.on('messages.delete', item => {
			if ('all' in item) {
				const list = messages[item.jid]
				list?.clear()
			} else {
				const jid = item.keys[0]?.remoteJid
				const list = jid ? messages[jid] : undefined
				if (list) {
					const idSet = new Set(item.keys.map(k => k.id))
					// BUG FIX: .filter() tidak mengubah array asli (not in-place).
					// Harus di-assign kembali ke list array.
					list.array = list.array.filter(m => !idSet.has(m.key.id))
				}
			}
		})

		ev.on('groups.update', updates => {
			for (const update of updates) {
				const id = update.id
				if (groupMetadata[id]) {
					Object.assign(groupMetadata[id], update)
				} else {
					logger.debug({ update }, 'got update for non-existent group metadata')
				}
			}
		})

		ev.on('group-participants.update', ({ id, participants, action }) => {
			const metadata = groupMetadata[id]
			if (metadata) {
				try {
					// Optimasi: Gunakan Set untuk pencarian lebih cepat (O(1))
					const participantSet = new Set(participants)
					switch (action) {
						case 'add':
							metadata.participants.push(...participants.map(id => ({ id, isAdmin: false, isSuperAdmin: false })))
							break
						case 'demote':
						case 'promote':
							for (const participant of metadata.participants) {
								if (participantSet.has(participant.id)) {
									participant.isAdmin = action === 'promote'
									// isSuperAdmin tidak di-set di sini, hanya isAdmin
								}
							}
							break
						case 'remove':
							metadata.participants = metadata.participants.filter(p => !participantSet.has(p.id))
							break
					}
				} catch (error) {
					logger.error({ err: error }, 'Error processing group-participants.update')
				}
			}
		})

		ev.on('message-receipt.update', updates => {
			for (const { key, receipt } of updates) {
				const list = messages[key.remoteJid]
				const msg = list?.get(key.id)
				if (msg) {
					Utils.updateMessageWithReceipt(msg, receipt)
				}
			}
		})

		ev.on('messages.reaction', reactions => {
			for (const { key, reaction } of reactions) {
				const list = messages[key.remoteJid]
				const msg = list?.get(key.id)
				if (msg) {
					Utils.updateMessageWithReaction(msg, reaction)
				}
			}
		})
	}

	const toJSON = () => ({
		chats,
		contacts,
		messages,
		labels,
		labelAssociations,
	})

	const fromJSON = (json) => {
		chats.upsert(...json.chats)
		if (json.labelAssociations) {
			labelAssociations.upsert(...json.labelAssociations)
		}
		contactsUpsert(Object.values(json.contacts))
		if (json.labels) {
			labelsUpsert(Object.values(json.labels))
		}
		for (const jid in json.messages) {
			const list = assertMessageList(jid)
			for (const msg of json.messages[jid]) {
				list.upsert(WAProto.WebMessageInfo.fromObject(msg), 'append')
			}
		}
	}

	return {
		chats,
		contacts,
		messages,
		groupMetadata,
		state,
		presences,
		labels,
		labelAssociations,
		bind,
		/** Memuat riwayat pesan dari sebuah chat. */
		loadMessages: async (jid, count, cursor) => {
			const list = assertMessageList(jid)
			const mode = !cursor || 'before' in cursor ? 'before' : 'after'
			const cursorKey = cursor ? (mode === 'before' ? cursor.before : cursor.after) : undefined
			const cursorValue = cursorKey ? list.get(cursorKey.id) : undefined

			let messageSlice
			if (list && mode === 'before' && (!cursorKey || cursorValue)) {
				const endIdx = cursorValue ? list.array.findIndex(m => m.key.id === cursorKey?.id) : list.array.length
				const startIdx = Math.max(0, endIdx - count)
				messageSlice = list.array.slice(startIdx, endIdx)
			} else {
				messageSlice = []
			}
			return messageSlice
		},
		/** Memuat detail sebuah pesan. */
		loadMessage: async (jid, id) => messages[jid]?.get(id),
		/** Mendapatkan pesan terbaru dari sebuah chat. */
		mostRecentMessage: async (jid) => messages[jid]?.array.slice(-1)[0],
		/** Mengambil URL gambar profil dengan fallback. */
		fetchImageUrl: async (jid, sock) => {
			const contact = contacts[jid]
			if (!contact) {
				return sock?.profilePictureUrl(jid, 'image').catch(() => undefined)
			}
			if (typeof contact.imgUrl === 'undefined') {
				contact.imgUrl = await sock?.profilePictureUrl(jid, 'image').catch(() => null) // null untuk menandakan sudah dicoba
			}
			return contact.imgUrl
		},
		/** Mengambil metadata grup dengan caching. */
		fetchGroupMetadata: async (jid, sock) => {
			if (!groupMetadata[jid]) {
				const metadata = await sock?.groupMetadata(jid)
				if (metadata) {
					groupMetadata[jid] = metadata
				}
			}
			return groupMetadata[jid]
		},
		/** Mengambil tanda terima (receipts) dari sebuah pesan. */
		fetchMessageReceipts: async ({ remoteJid, id }) => messages[remoteJid]?.get(id)?.userReceipt,
		/** Mengambil metadata broadcast list dengan caching. */
		fetchBroadcastListInfo: async (jid, sock) => {
			if (!groupMetadata[jid]) {
				const metadata = await sock?.getBroadcastListInfo(jid)
				if (metadata) {
					groupMetadata[jid] = metadata
				}
			}
			return groupMetadata[jid]
		},
		toJSON,
		fromJSON,
		/** Menulis state store ke file JSON. */
		writeToFile: (path) => {
			try {
				writeFileSync(path, JSON.stringify(toJSON()))
			} catch (error) {
				logger.error({ err: error, path }, 'Failed to write store to file')
			}
		},
		/** Membaca state store dari file JSON. */
		readFromFile: (path) => {
			try {
				if (existsSync(path)) {
					logger.info({ path }, 'Reading store from file...')
					const jsonStr = readFileSync(path, { encoding: 'utf-8' })
					const json = JSON.parse(jsonStr)
					fromJSON(json)
				}
			} catch (error) {
				logger.error({ err: error, path }, 'Failed to read store from file')
			}
		},
	}
}

module.exports = {
	waChatKey,
	waMessageID,
	waLabelAssociationKey,
	makeInMemoryStore,
}
