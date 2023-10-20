require('dotenv/config')

const app = require('express')();
const fs = require('fs');
const request = require('request');
const url = require('url');
const atob = require('atob');
let mysql = require('mysql');
let dbConfig = require('./dbconfig.js');
const gravitec = require('./gravitec.js');
const socketHelper = require("./socketHelper.js")
const winston = require('winston');
const osc = require('./onesignalconfig.js');
const { oneSignalConfig } = osc;

// setTimeout(() => {
// 	oneSignal.sendNotification();
// 	console.log("oneSignal.oneSignalClient")
// 	console.log(oneSignal.oneSignalClient)
// 	console.log("oneSignal.oneSignalClient")
// }, 3000);

//Für Lokal:
// const http = require('http').Server(app);
// const io = require('socket.io')(http);


const https = require('https').createServer({
	key: fs.readFileSync('/etc/ssl/letsEncrypt/domain.key'),
	//cert: fs.readFileSync('/etc/ssl/letsEncrypt/signed.crt'),
	cert: fs.readFileSync('/etc/ssl/letsEncrypt/chained.pem'),
	ca: fs.readFileSync('/etc/ssl/letsEncrypt/intermediate.pem')
}, app);

const io = require('socket.io')(https, {
	transports: ['polling', 'websocket'],
});

// Initialize tour data
const tours = {};

const sockets = {};
const sessionIdUserMap = {};
const userIdSocketIdMap = {};

const logger = winston.createLogger({
	//level: 'info',
	format: winston.format.simple(),
	// defaultMeta: { service: 'user-connections' },
	transports: [
		new winston.transports.File({ filename: './logs/error.log', level: 'error' }),
		new winston.transports.File({ filename: './logs/combined.log', level: 'info' }),
	],
});

clearOnlineUsersTables();

io.on('connection', (socket) => {
	try {
		console.log('connection', socket.id);

		sockets[socket.id] = socket;
		console.log(socket.id);

		const sessionId = socket.handshake.query.sessionId;
		const userId = socket.handshake.query.userId;
		const userName = socket.handshake.query.userName;
		const userAvatarUrl = socket.handshake.query.userAvatarUrl || '';
		const worldId = socket.handshake.query.worldId || 0;
		const wpId = socket.handshake.query.wpId || false;
		const currentSceneId = socket.handshake.query.currentSceneId || null;
		const currentSceneName = socket.handshake.query.currentSceneName || null;
		const creatorUserIdOfWorld = socket.handshake.query.creatorUserIdOfWorld || null;
		const url = socket.handshake.query.url || null;
		const webcamStreamId = socket.handshake.query.webcamStreamId || null;
		const screenStreamId = socket.handshake.query.screenStreamId || null;
		const isGuest = isNaN(Number(userId));
		const on1on1Call = socket.handshake.query.on1on1Call || false;
		const worldName = socket.handshake.query.worldName || "worldName";
		const socketId = socket.id;

		if (!sessionId || !userId) {
			console.log('KEINE QUERY DATA!!!! (sessionId oder userId fehlt)', socket.id, JSON.stringify(socket.handshake.query));
			socket.disconnect(true);
			return;
		}

		if (worldId && worldId !== '0') {
			changeWorldOnlineUsers(worldId, userId, 1);
		} else {
			console.warn('Kein Parameter "worldId".', socket.id, JSON.stringify(socket.handshake.query));
		}

		sessionIdUserMap[sessionId] = sessionIdUserMap[sessionId] || {};
		sessionIdUserMap[sessionId][userId] = {
			userId: userId,
			userName: userName || '?',
			userAvatarUrl: userAvatarUrl,
			currentSceneId: currentSceneId,
			currentSceneName: currentSceneName,
			creatorUserIdOfWorld: creatorUserIdOfWorld,
			currentUserMood: 1,
			userVideoOn: false,
			userScreenShareOn: false,
			audioLevels: 0,
			hasProfile: wpId,
			url,
			webcamStreamId: webcamStreamId,
			screenStreamId: screenStreamId,
			isGuest,
			worldId,
			worldName,
			socketId
		};
		userIdSocketIdMap[userId] = socket.id;

		socket.join(sessionId);

		// Check if the tour data has the same worldId as the user
		const tourWithSameWorldId = Object.values(tours).find((tour) => tour.worldId === worldId);
		if (tourWithSameWorldId) {
			// Emit join-tour event to the user with the tour data
			socket.emit('join-tour', { message: 'Joining tour with the same worldId', tour: tourWithSameWorldId });
		}
		socket.emit('tour-init', tours);

		sendMessageToAllWithoutMe(socket, sessionId, {
			eventName: 'sessionConnected',
			senderId: userId,
			data: sessionIdUserMap[sessionId][userId],
		});

		io.emit('message', {
			eventName: 'sessionConnected_global',
			senderId: userId,
			data: sessionIdUserMap[sessionId][userId]
		});

		const currentUser = {};
		Object.keys(sessionIdUserMap[sessionId]).forEach((userId) => {
			currentUser[userId] = sessionIdUserMap[sessionId][userId];
		});
		sendMessageToOne(socket, sessionId, userId, {
			eventName: 'currentUsers',
			senderId: userId,
			data: currentUser,
		});

		//iwfowner is not in users sessions say notify him
		const owner = socketHelper.findUserById(creatorUserIdOfWorld, sessionIdUserMap);
		if (owner) {
			// console.log("ARE IN SAME ROOM ")
			// console.log(owner.data.currentSceneId, "<-owner-room      user room->", currentSceneId,)
			// console.log(owner.data.currentSceneId === currentSceneId)
			if (owner.data.currentSceneId === currentSceneId) {
				//user shares same location
			}
			else {
				const m = `User "${userName}" has entered your Room "${worldName}".Click here to go to room`;
				const t = `bagless.io info`;
				gravitec.sendNotificaionToUser(t, m, url, creatorUserIdOfWorld);
			}
		}
		if (!owner && socketHelper.isSceneEmpty(sessionIdUserMap[sessionId], currentSceneId)) {
			/// no owner scene is empty, we enetred it , notify user
			const m = `User "${userName}" has entered your Room "${worldName}".Click here to go to room`;
			const t = `bagless.io info`;
			gravitec.sendNotificaionToUser(t, m, url, creatorUserIdOfWorld);
		}

		socket.on('message', (payload) => {
			try {
				//console.log('message', socket.id, payload);
				if (payload.eventName !== 'userAudioLevelsChanged') {
					console.log('message', socket.id, payload);
				}
				if (payload.eventName === 'requestChatHistory') {
					const socketId = userIdSocketIdMap[payload.userId];
					const senderId = userIdSocketIdMap[payload.senderId];
					const cb = (chatHistory) => {
						console.log(chatHistory)
						payload.chatHistory = chatHistory
						sendMessageToOne(socket, sessionId, payload.userId, payload)
					}
					if (!isNaN(Number(payload.userId)) || !isNaN(Number(payload.senderId))) {
						getChatmessages(payload.userId, payload.senderId, payload.text, cb)
					}
					return;
				}

				if (payload.eventName === 'sceneJoined') {
					if (sessionIdUserMap[sessionId][userId]) {
						const oldSceneId = sessionIdUserMap[sessionId][userId]['currentSceneId'];
						if (socketHelper.isSceneEmpty(sessionIdUserMap[sessionId], oldSceneId)) {
							if (sessionIdUserMap[sessionId].lockedRooms) {
								//room is empty, delete and emmit emptyLockedRoom
								sessionIdUserMap[sessionId].lockedRooms[oldSceneId] = null;
								delete sessionIdUserMap[sessionId].lockedRooms[oldSceneId];

								io.in(sessionId).emit('message', {
									eventName: 'userLockRoom',
									userId: userId,
									lockedRooms: sessionIdUserMap[sessionId].lockedRooms,
								});
							}
						}

						sessionIdUserMap[sessionId][userId]['currentSceneId'] = payload.data.sceneId;
						sessionIdUserMap[sessionId][userId]['currentSceneName'] = payload.data.sceneName || 'Limbus';
					}
				}

				if (payload.eventName === 'userMoodChanged') {
					if (sessionIdUserMap[sessionId][userId]) {
						sessionIdUserMap[sessionId][userId]['currentUserMood'] = payload.data.newMood;
					}

					io.emit('message', {
						eventName: 'userMoodChanged_global',
						senderId: payload.senderId,
						data: payload.data
					});
				}

				if (payload.eventName === 'userAvatarChanged') {
					io.emit('message', {
						eventName: 'userAvatarChanged',
						senderId: payload.senderId,
						data: payload.data
					});
				}
				if (payload.eventName === 'getUsersInfo') {
					const socketId = userIdSocketIdMap[payload.senderId];
					const users = [];
					console.log(socketId)
					payload.userIds.forEach((id) => {
						const userId = Number(id);
						Object.keys(sessionIdUserMap).forEach((key) => {
							if (sessionIdUserMap[key][userId]) {
								users.push(sessionIdUserMap[key][userId])
							}
						})
					})
					sendMessageToOne(socket, sessionId, payload.senderId, {
						eventName: 'getUsersInfo',
						users,
					})
					return;
				}
				if (payload.eventName === 'sendGlobalInvite') {
					let onlineUser;
					if (payload.invite) {
						onlineUser = socketHelper.findUserById(payload.receiverId, sessionIdUserMap);
						onlineUser && sendMessageToOne(socket, sessionId, payload.senderId, {
							eventName: 'sendGlobalInvite',
							onlineUser,
							invite: payload.invite,
							url: `id=${onlineUser.data.worldId}&loc=${currentSceneId}`,
						})
						return;
					} else {
						onlineUser = socketHelper.findUserById(payload.senderId, sessionIdUserMap);
						onlineUser && sendMessageToOne(socket, sessionId, payload.receiverId, {
							eventName: 'sendGlobalInvite',
							onlineUser,
							invite: payload.invite,
							url: `id=${onlineUser.data.worldId}&loc=${onlineUser.data.currentSceneId}`,
						})
					}
					return;
				}
				if (payload.eventName === 'sendGlobalTourInvite') {
					let onlineUser;
					onlineUser = socketHelper.findUserById(payload.senderId, sessionIdUserMap);
					onlineUser && sendMessageToOne(socket, sessionId, payload.receiverId, {
						eventName: 'sendGlobalTourInvite',
						onlineUser,
						sender: payload.sender,
						tourData: payload.tourData,
					})
					return;
				}

				if (payload.eventName === 'userVideoStateChanged') {
					if (sessionIdUserMap[sessionId][userId]) {
						sessionIdUserMap[sessionId][userId]['userVideoOn'] = payload.data.userVideoOn;
						sessionIdUserMap[sessionId][userId]['on1on1Call'] = payload.data.on1on1Call;
					}
				}

				if (payload.eventName === 'userScreenShareStateChanged') {
					if (sessionIdUserMap[sessionId][userId]) {
						sessionIdUserMap[sessionId][userId]['userScreenShareOn'] = payload.data.userScreenShareOn;
						sessionIdUserMap[sessionId][userId]['objId'] = payload.data.objId;
					}
				}

				if (payload.eventName === 'userAudioLevelsChanged') {
					if (sessionIdUserMap[sessionId][userId]) {
						sessionIdUserMap[sessionId][userId]['audioLevels'] = payload.data.newAudioLevels;
					}
				}

				if (payload.eventName === 'videoOneOnOne_request') {
					const receiverId = payload.data.userId;
					const socketId = userIdSocketIdMap[receiverId];
					socket.broadcast.to(socketId).emit('message', payload);
					return;
				}

				if (payload.eventName === 'videoOneOnOne_reject') {
					const callInitiatorID = payload.data.callInitiatorID;
					const socketId = userIdSocketIdMap[callInitiatorID];
					socket.broadcast.to(socketId).emit('message', payload);
					return;
				}

				if (payload.eventName === 'startRoomInvitation') {
					const wantedSceneId = payload.wantedSceneId;
					const socketId = userIdSocketIdMap[payload.receiverId];
					socket.broadcast.to(socketId).emit('message', payload);
					return;
				}
				if (payload.eventName === 'sendSignalNotification') {
					const { userId, url, message, senderName } = payload;
					if (userId) {
						const data = [userId];
						const m = { "en": `Message from ${senderName}` };
						const t = { "en": message };
						// oneSignal.sendNotification(data, t, m, url)
					}
				}

				if (payload.eventName === 'videoOneOnOne_cancel') {
					socket.broadcast.emit('message', payload);
				}

				if (payload.eventName === 'environmentChanged') {
					console.log('environment changed', payload)
					socket.to(sessionId).emit('message', payload);
				}

				if (payload.eventName === 'checkOwnerStatus') {
					const ownerId = payload.data.userId;
					let ownerData = null;

					for (let sessionId in sessionIdUserMap) {
						if (sessionIdUserMap[sessionId].hasOwnProperty(ownerId)) {
							ownerData = sessionIdUserMap[sessionId][ownerId];
							break;
						}
					}

					socket.emit('message', {
						eventName: 'checkOwnerStatus',
						senderId: payload.senderId,
						data: ownerData
					});
				}

				if (payload.eventName === 'updateUserData') {
					updateUserData(sessionId, userId, payload.data);
					return;
				}

				if (payload.eventName === 'userChangingSeat') {
					if (!payload.seatId) {
						return;
					}

					if (!sessionIdUserMap[sessionId].occupiedSeats) {
						sessionIdUserMap[sessionId].occupiedSeats = {};
					}

					if (payload.userId && payload.userId !== '0') {
						//Ggf. auf einem bestehenden Sitz entfernen
						for (const [seatId, currentUserId] of Object.entries(sessionIdUserMap[sessionId].occupiedSeats)) {
							if (currentUserId === payload.userId) {
								sessionIdUserMap[sessionId].occupiedSeats[seatId] = null;
								delete sessionIdUserMap[sessionId].occupiedSeats[seatId];
							}
						}
						sessionIdUserMap[sessionId].occupiedSeats[payload.seatId] = payload.userId;
					} else {
						sessionIdUserMap[sessionId].occupiedSeats[payload.seatId] = null;
						delete sessionIdUserMap[sessionId].occupiedSeats[payload.seatId];
					}

					io.in(sessionId).emit('message', {
						eventName: 'userChangedSeat',
						userId: userId,
						occupiedSeats: sessionIdUserMap[sessionId].occupiedSeats,
					});
					return;
				}
				if (payload.eventName === 'userChangingScreenShareSeat') {
					if (!payload.seatId) {
						return;
					}

					if (!sessionIdUserMap[sessionId].screenShareOccupiedSeats) {
						sessionIdUserMap[sessionId].screenShareOccupiedSeats = {};
					}

					if (payload.userId && payload.userId !== '0') {
						//Ggf. auf einem bestehenden Sitz entfernen
						for (const [seatId, currentUserId] of Object.entries(sessionIdUserMap[sessionId].screenShareOccupiedSeats)) {
							if (currentUserId === payload.userId) {
								sessionIdUserMap[sessionId].screenShareOccupiedSeats[seatId] = null;
								delete sessionIdUserMap[sessionId].screenShareOccupiedSeats[seatId];
							}
						}
						sessionIdUserMap[sessionId].screenShareOccupiedSeats[payload.seatId] = payload.userId;
					} else {
						sessionIdUserMap[sessionId].screenShareOccupiedSeats[payload.seatId] = null;
						delete sessionIdUserMap[sessionId].screenShareOccupiedSeats[payload.seatId];
					}

					io.in(sessionId).emit('message', {
						eventName: 'userChangedScreenShareSeat',
						userId: userId,
						screenShareOccupiedSeats: sessionIdUserMap[sessionId].screenShareOccupiedSeats,
					});
					return;
				}
				if (payload.eventName === 'tour_userChangingScreenShareSeat') {
					if (!payload.seatId) {
						return;
					}

					if (!sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats) {
						sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats = {};
					}

					if (payload.userId && payload.userId !== '0') {
						//Ggf. auf einem bestehenden Sitz entfernen
						for (const [seatId, currentUserId] of Object.entries(sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats)) {
							if (currentUserId === payload.userId) {
								sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[seatId] = null;
								delete sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[seatId];
							}
						}
						sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[payload.seatId] = payload.userId;
					} else {
						sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[payload.seatId] = null;
						delete sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[payload.seatId];
					}

					io.in(sessionId).emit('message', {
						eventName: 'tour_userChangedScreenShareSeat',
						userId: userId,
						tour_screenShareOccupiedSeats: sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats,
					});
					return;
				}
				if (payload.eventName === 'userChangingScreen') {
					if (!payload.screenId) {
						return;
					}

					if (!sessionIdUserMap[sessionId].occupiedScreens) {
						sessionIdUserMap[sessionId].occupiedScreens = {}
					}

					if (payload.userId && payload.userId !== '0') {
						//Ggf. auf einem bestehenden Sitz entfernen
						for (const [screenId, currentUserId] of Object.entries(sessionIdUserMap[sessionId].occupiedScreens)) {
							if (currentUserId === payload.userId) {
								sessionIdUserMap[sessionId].occupiedScreens[screenId] = null;
							}
						}

						sessionIdUserMap[sessionId].occupiedScreens[payload.screenId] = payload.userId;
					} else {
						sessionIdUserMap[sessionId].occupiedScreens[payload.screenId] = null;
					}

					io.in(sessionId).emit('message', {
						eventName: 'userChangedScreen',
						userId: userId,
						occupiedScreens: sessionIdUserMap[sessionId].occupiedScreens,
					});
					return;
				}
				if (payload.eventName === 'request_shareScreen') {
					const receiverId = payload.data.userId;
					const socketId = userIdSocketIdMap[receiverId];
					socket.broadcast.to(socketId).emit('message', payload);
				}
				if (payload.eventName === 'approved_shareScreen') {
					const receiverId = payload.data.userId;
					const socketId = userIdSocketIdMap[receiverId];
					socket.broadcast.to(socketId).emit('message', payload);
				}
				if (payload.eventName === 'raiseHand') {
					sendMessageToAllWithoutMe(socket, sessionId, payload)
					return
				}
				if (payload.eventName === 'guideModeOn') {
					console.log("guideModeOn", payload);
					if (payload.componentValue) {
						payload.componentValue.forEach((user) => {
							const { socketId } = user;
							payload.tour = tours;
							// Send a tour started message to each user individually
							sendMessageToOne(socket, sessionId, user.userId, payload);
						});
					}
					return;
					// sendMessageToAllWithoutMe(socket, sessionId, payload)
				}
				if (payload.eventName === 'guideModeOff') {

					sendMessageToAllWithoutMe(socket, sessionId, payload)
				}
				if (payload.eventName === 'guidedCamera') {
					sendMessageToAllWithoutMe(socket, sessionId, payload)
				}
				if (payload.eventName === 'acceptGuideMode') {
					console.log("acceptGuideMode")
					sendMessageToAllWithoutMe(socket, sessionId, payload)
				}
				if (payload.eventName === 'inviteAsTourContributore') {
					sendMessageToOne(socket, sessionId, payload.receiverId, payload);
					return;
				}
				if (payload.eventName === 'sendGlobalTourinvite') {
					sendMessageToOne(socket, sessionId, payload.userId, payload);
					return;
				}
				if (payload.eventName === 'killTourGuestMode') {
					sendMessageToAll(sessionId, payload);
					return;
				}
				if (payload.eventName === 'inviteAsTourGuest') {
					console.log(payload)
					sendMessageToOne(socket, sessionId, payload.receiverId, payload);
					return;
				}
				if (payload.eventName === 'userLockingRoom') {
					if (!payload.sceneId) {
						return;
					}

					if (!sessionIdUserMap[sessionId].lockedRooms) {
						sessionIdUserMap[sessionId].lockedRooms = {};
					}

					if (payload.userId && payload.userId !== '0') {
						// sessionIdUserMap[sessionId].lockedRooms[payload.sceneId] = payload.userId;
						sessionIdUserMap[sessionId].lockedRooms[payload.sceneId] = true;
					} else {
						// sessionIdUserMap[sessionId].lockedRooms[payload.sceneId] = null;
						sessionIdUserMap[sessionId].lockedRooms[payload.sceneId] = null;
						delete sessionIdUserMap[sessionId].lockedRooms[payload.sceneId];
					}

					io.in(sessionId).emit('message', {
						eventName: 'userLockRoom',
						userId: userId,
						lockedRooms: sessionIdUserMap[sessionId].lockedRooms,
					});
					return;
				}
				if (payload.eventName === 'chatOfflineMessage') {
					const receiverId = payload.receiverId;
					const t = `bagless.io info`;
					const m = `User "${userName}" has send you a message while you were offline. Do you want to goback online to the room “${worldName}”`;
					gravitec.sendNotificaionToUser(t, m, url, receiverId)
				}

				if (payload.receiverType === 'user' && payload.receiverId) {
					if (sessionIdUserMap[sessionId][userId].isGuest) {
						return;
					}
					payload.time = new Date().getTime();
					const cb = () => {
						sendMessageToOne(socket, sessionId, payload.receiverId, payload)
					};
					if (!isNaN(Number(payload.receiverId)) || !isNaN(Number(payload.senderId))) {
						addChatMessage(payload.senderId, payload.receiverId, payload.text, cb);
					} else {
						sendMessageToOne(socket, sessionId, payload.receiverId, payload)
					}
				}
				else if (payload.receiverType === 'tour' && payload.senderId) {
					sendMessageToAllWithoutMe(socket, sessionId, payload);
				}
				else if (payload.receiverType === 'acceptLockRequest' && payload.senderId) {
					///curently handling as pvt requests (idea is request appear in chat)
					sendMessageToAllWithoutMe(socket, sessionId, payload);
				}
				else if (payload.receiverType === 'lockRequest' && payload.receiverId) {
					///curently handling as pvt requests (idea is request appear in chat)
					sendMessageToAllWithoutMe(socket, sessionId, payload);
				}
				else if (payload.eventName === 'tour-send-emoticon') {
					sendMessageToAllWithoutMe(socket, sessionId, payload);
				}
				else {
					if (sessionIdUserMap[sessionId][userId].isGuest) {
						return;
					}
					payload.time = new Date().getTime();
					const cb = () => {
						sendMessageToAllWithoutMe(socket, sessionId, payload);
					};
					if (payload.text) {
						if (payload.receiverType && payload.receiverType === "local") {
							console.log(payload, "payload")
							addRoomMessage(payload.senderId, payload.sceneId, payload.text, cb)
						}
						else {
							addWorldMessage(payload.senderId, worldId, payload.text, cb)
						}
					} else {
						cb();
					}
				}
			} catch (exception) {
				console.error('message', new Date().toString(), socket.id, exception);
			}
		});

		socket.emit("me", socket.id);
		socket.on("callUser", (payload) => {
			console.log("CALL USER CALLLED")
			console.log("CALL USER CALLLED")
			const { userToCall, signalData, from, name } = payload;
			io.to(userToCall).emit("callUser", { signal: signalData, from, name });
		});

		socket.on("answerCall", (data) => {
			console.log("ANSWER CALL CALLLED")
			io.to(data.to).emit("callAccepted", data.signal)
		});

		socket.on("declinedCall", (data) => {
			io.to(data.to).emit("declinedCall", data.signal)
		});

		socket.on('webRtcData', payload => {
			socket.to(sessionId).emit('webRtcData', payload);
		});
		socket.on('guidedCamera', payload => {
			socket.to(sessionId).emit('guidedCamera', payload);
		});
		socket.on('canvas', payload => {
			socket.to(sessionId).emit('canvas', payload);
		});

		socket.on('gaming', payload => {

			if (payload.eventName === 'GET_INITIAL_GAME_DATA') {
				if (!payload.gameId) {
					return;
				}

				if (!sessionIdUserMap[sessionId].games) {
					sessionIdUserMap[sessionId].games = {};
				}
				if (!sessionIdUserMap[sessionId].games[payload.gameId]) {
					sessionIdUserMap[sessionId].games[payload.gameId] = {};
					sessionIdUserMap[sessionId].games[payload.gameId].players = {};
					sessionIdUserMap[sessionId].games[payload.gameId].visitors = {};
					sessionIdUserMap[sessionId].games[payload.gameId].gameData = payload.gameData;
				}

				io.in(sessionId).emit('gaming', {
					eventName: 'GET_INITIAL_GAME_DATA',
					userId: payload.userId,
					gameId: payload.gameId,
					players: sessionIdUserMap[sessionId].games[payload.gameId].players,
					visitors: sessionIdUserMap[sessionId].games[payload.gameId].visitors,
					gameData: sessionIdUserMap[sessionId].games[payload.gameId].gameData
				});
				return;
			}

			if (payload.eventName === 'NEW_VISITOR') {
				if (!payload.gameId) {
					return;
				}

				if (!sessionIdUserMap[sessionId].games) {
					sessionIdUserMap[sessionId].games = {};
				}
				if (!sessionIdUserMap[sessionId].games[payload.gameId]) {
					sessionIdUserMap[sessionId].games[payload.gameId] = {};
					sessionIdUserMap[sessionId].games[payload.gameId].players = {};
					sessionIdUserMap[sessionId].games[payload.gameId].visitors = {};
					sessionIdUserMap[sessionId].games[payload.gameId].gameData = payload.gameData;
				}

				sessionIdUserMap[sessionId].games[payload.gameId].visitors[payload.userId] = payload.data;

				io.in(sessionId).emit('gaming', {
					eventName: 'NEW_VISITOR',
					userId: payload.userId,
					gameId: payload.gameId,
					players: sessionIdUserMap[sessionId].games[payload.gameId].players,
					visitors: sessionIdUserMap[sessionId].games[payload.gameId].visitors,
					gameData: sessionIdUserMap[sessionId].games[payload.gameId].gameData
				});
				return;
			}

			if (payload.eventName === 'NEW_PLAYER') {
				if (!payload.gameId) {
					return;
				}

				delete sessionIdUserMap[sessionId].games[payload.gameId].visitors[payload.userId];
				const gameData = sessionIdUserMap[sessionId].games[payload.gameId].gameData;
				sessionIdUserMap[sessionId].games[payload.gameId].gameData = { ...gameData, [payload.status]: payload.playerData };

				sessionIdUserMap[sessionId].games[payload.gameId].players[payload.userId] = payload.playerData;

				io.in(sessionId).emit('gaming', {
					eventName: 'NEW_PLAYER',
					userId: payload.userId,
					gameId: payload.gameId,
					players: sessionIdUserMap[sessionId].games[payload.gameId].players,
					visitors: sessionIdUserMap[sessionId].games[payload.gameId].visitors,
					gameData: sessionIdUserMap[sessionId].games[payload.gameId].gameData
				});
				return;
			}

			if (payload.eventName === 'GAME_RESET_SOCKET') {
				if (!payload.gameId) {
					return;
				}

				const gameData = sessionIdUserMap[sessionId].games[payload.gameId].gameData;
				sessionIdUserMap[sessionId].games[payload.gameId].gameData = { ...gameData, ...payload.data };

				io.in(sessionId).emit('gaming', {
					eventName: 'NEW_PLAYER',
					userId: payload.userId,
					gameId: payload.gameId,
					players: sessionIdUserMap[sessionId].games[payload.gameId].players,
					visitors: sessionIdUserMap[sessionId].games[payload.gameId].visitors,
					gameData: sessionIdUserMap[sessionId].games[payload.gameId].gameData
				});
				return;
			}

			if (payload.eventName === 'GAME_START') {
				if (!payload.gameId) {
					return;
				}

				const gameData = sessionIdUserMap[sessionId].games[payload.gameId].gameData;
				sessionIdUserMap[sessionId].games[payload.gameId].gameData = { ...gameData, ...payload.gameData };

				io.in(sessionId).emit('gaming', {
					eventName: 'GAME_START',
					userId: payload.userId,
					gameId: payload.gameId,
					players: sessionIdUserMap[sessionId].games[payload.gameId].players,
					visitors: sessionIdUserMap[sessionId].games[payload.gameId].visitors,
					gameData: sessionIdUserMap[sessionId].games[payload.gameId].gameData
				});
				return;
			}

			if (payload.eventName === 'RESTART_GAME') {
				if (!payload.gameId) {
					return;
				}

				const gameData = sessionIdUserMap[sessionId].games[payload.gameId].gameData;
				sessionIdUserMap[sessionId].games[payload.gameId].gameData = { ...gameData, ...payload.gameData };

				io.in(sessionId).emit('gaming', {
					eventName: 'RESTART_GAME',
					userId: payload.userId,
					gameId: payload.gameId,
					players: sessionIdUserMap[sessionId].games[payload.gameId].players,
					visitors: sessionIdUserMap[sessionId].games[payload.gameId].visitors,
					gameData: sessionIdUserMap[sessionId].games[payload.gameId].gameData
				});
				return;
			}

			if (payload.eventName === 'UPDATE_GAME_DATA') {
				if (!payload.gameId) {
					return;
				}

				const gameData = sessionIdUserMap[sessionId].games[payload.gameId].gameData;
				sessionIdUserMap[sessionId].games[payload.gameId].gameData = { ...gameData, ...payload.data };

				io.in(sessionId).emit('gaming', {
					eventName: 'GAME_DATA_CHANGED',
					userId: payload.userId,
					gameId: payload.gameId,
					action: payload.action,
					players: sessionIdUserMap[sessionId].games[payload.gameId].players,
					visitors: sessionIdUserMap[sessionId].games[payload.gameId].visitors,
					gameData: sessionIdUserMap[sessionId].games[payload.gameId].gameData
				});
				return;
			}

			if (payload.eventName === 'VISITOR_OR_PLAYER_LEFT') {
				if (!payload.gameId) {
					return;
				}

				sessionIdUserMap[sessionId].games[payload.gameId].players[payload.userId] && (delete sessionIdUserMap[sessionId].games[payload.gameId].players[payload.userId]);
				sessionIdUserMap[sessionId].games[payload.gameId].visitors[payload.userId] && (delete sessionIdUserMap[sessionId].games[payload.gameId].visitors[payload.userId]);

				payload.userStatus === 'player' && resetPlayer(sessionId, payload.gameId, userId);

				io.in(sessionId).emit('gaming', {
					eventName: 'VISITOR_OR_PLAYER_LEFT',
					userId: payload.userId,
					gameId: payload.gameId,
					userStatus: payload.userStatus,
					players: sessionIdUserMap[sessionId].games[payload.gameId].players,
					visitors: sessionIdUserMap[sessionId].games[payload.gameId].visitors,
					gameData: sessionIdUserMap[sessionId].games[payload.gameId].gameData,
				});
				return;
			}
		});

		socket.on('signalData', payload => {
			//console.log('signalData ', payload);
			socket.to(sessionId).emit('signalData', payload);
			if (payload.type) {

				let d = new Date();
				let datestring = d.getDate() + "-" + (d.getMonth() + 1) + "-" + d.getFullYear() + " " +
					d.getHours() + ":" + d.getMinutes() + ":" + d.getMilliseconds();
				if (payload.type === 'user-started-webcam') {
					logger.info('user-started-webcam @ ' + datestring, { 'displayName': payload.displayName, 'userId': payload.userId, 'userScreenShareOn': payload.userScreenShareOn, 'userVideoOn': payload.userVideoOn, 'uuid': payload.uuid });
				}
				// if (payload.type === 'video-offer') {
				// 	logger.info('video-offer @ ' + datestring + ' from ' + payload.displayName, { 'userId': payload.userId, 'userScreenShareOn': payload.userScreenShareOn, 'userVideoOn': payload.userVideoOn, 'uuid': payload.uuid });
				// }
				// if (payload.type === 'video-answer') {
				// 	logger.info('video-answer @ ' + datestring + ' from ' + payload.displayName, { 'userId': payload.userId, 'userScreenShareOn': payload.userScreenShareOn, 'userVideoOn': payload.userVideoOn, 'uuid': payload.uuid });
				// }

				// if (payload.type === 'user-started-screen') {
				// 	logger.info('user-started-screen @ ' + datestring, 'payload');
				// }
				// if (payload.type === 'screen-offer') {
				// 	logger.info('screen-offer @ ' + datestring + ' from ' + payload.displayName, 'payload');
				// }
				// if (payload.type === 'screen-answer') {
				// 	logger.info('screen-answer @ ' + datestring + ' from ' + payload.displayName, 'payload');
				// }
			}
		});


		///NEW TOUR START
		socket.on('tour-start', (payload) => {
			const { tourId, users, name, worldId, socketId } = payload;
			if (tours[tourId] && socketId) {
				io.to(socketId).emit('tour-joined', { message: 'Tour already exists', tour: tours[tourId] });
				return;
			}
			const tour = {
				id: tourId,
				owner: socket.id,
				canInviteGuest: true,
				owner_userId: userId,
				contributors: [],
				raisedHands: [],
				users: [],
				guests: [],
				streams: {},
				name: name,
				worldId: worldId,
			};
			// store streamId;
			tour.streams[socket.id] = payload.streamId;
			// Store the tour object in the tours data structure
			tours[tourId] = tour;
			// Add each user to the tour's users array
			users.forEach((user) => {
				tour.users.push(user);
				// Send a tour started message to each user individually
				io.to(socketId).emit('tour-started', { message: 'Tour started', tour: tour });
			});
			io.emit('tour-data-on-start', { message: 'tour-data', tours: tours });
			if (users.length === 0) {
				socket.emit('tour-started', { message: 'Tour started', tour: tour });
			}
		});
		// Event: Tour End
		socket.on('tour-end', () => {
			// Retrieve the tour object based on the current tour ID
			let tour;
			let tourId;
			// Find the tour that the socket is associated with
			Object.keys(tours).find((tId) => {
				if (tours[tId].owner === socket.id) {
					tour = tours[tId];
					tourId = tId;
				}
			})
			if (tour && tour.owner === socket.id) {
				// Broadcast tour end event to all clients
				io.emit('tour-ended', { message: 'Tour ended', tour: tour });
				// Remove the tour from the tours data structure
				delete tours[tourId];
			} else {
				// Emit an error event to the client
				socket.emit('tour-end-error', { message: 'You are not the owner of the tour' });
			}
		});
		socket.on('tour-joined', (payload) => {
			const tourId = payload.tourId;
			const tour = tours[tourId];
			if (tour) {
				tour.streams && (tour.streams[socket.id] = payload.streamId);
				// Check if the user is already in the tour
				const existingUser = tour.users.find((socketId) => socketId === socket.id);
				if (!existingUser) {
					// Add the user to the tour's users array
					tour.users.push(socket.id);
					// Notify all users in the tour about the new user joining
					io.in(sessionId).emit('tour-new-user', { message: 'New user joined the tour', tour: tour, user: sessionIdUserMap[sessionId][userId] });
				}
				socket.emit('tour-new-user', { message: 'New user joined the tour', tour: tour, user: sessionIdUserMap[sessionId][userId] });
				// io.in(sessionId).emit('tour-update', { message: 'New user joined the tour', tour: tour, newUser: socket.id });
				console.log("tour joined", payload);
			}
			else {
				console.log("tour does not exists", payload.tourId);
			}
		});
		socket.on('tour-data', (payload) => {
			const { name, tourID } = payload;
			tours[tourID].name = name;
			io.in(sessionId).send(tours);
		});
		socket.on('tour-update', (payload) => {
			const tour = tours[payload.tourId];
			tour.name = payload.name;
			io.in(sessionId).send({ eventName: "tour-update", tour });
		});
		socket.on('tour-clicked', (payload) => {
			console.log("tour-clicked", payload);
			console.log("tour-clicked", payload);
			console.log("tour-clicked", payload);
			const tour = findTourFromSocketId(socket.id);
			if (tour) {
				tour.users.forEach((user) => {
					socket.broadcast.to(user).emit('tour-clicked', { ...payload });
				});
			}
		});
		socket.on('tour-leave', (payload) => {
			const tour = findTourFromSocketId(socket.id);
			if (!tour) {
				console.log("NO TOUR FOUND FOR USER")
				return;
			}
			if (tour.owner === socket.id) {
				// Notify the remaining users about the user leaving the tour
				tour.users.forEach((user) => {
					socket.broadcast.to(user).emit('tour-ended', { message: 'Tour destroyed' });
				});
				delete tours[tour.id];
			} else {
				// Check if the user is already in the tour
				const existingUser = tour.users.find((socketId) => socketId === socket.id);
				if (existingUser) {
					// remove user
					tour.users = tour.users.filter(socketId => socketId !== socket.id)
					tour.guests = tour.guests.filter(socketId => socketId !== socket.id)
					tour.contributors = tour.contributors.filter(socketId => socketId !== socket.id)
					// Notify all users in the tour about the new user joining
					tour.users.forEach((user) => {
						// Send a tour started message to each user individually
						io.to(socketId).emit('tour-left', { message: 'User left the tour', tour: tour, user: sessionIdUserMap[sessionId][userId] });
					});
					socket.emit('tour-left', { message: 'User left the tour', tour: tour, user: sessionIdUserMap[sessionId][userId] });
					io.to(tour.owner).emit('tour-left', { message: 'User left the tour', tour: tour, user: sessionIdUserMap[sessionId][userId] });
				}
			}
		});
		// Event: tour-contributor-invite
		socket.on('tour-contributor-invite', (payload) => {
			const inviteeId = payload.inviteeId;
			const senderId = payload.senderId;
			const tour = findTourFromSocketId(inviteeId)
			// Find the tour with the given tourId
			if (!tour) {
				console.log("NO TOUR FOUND FOR USER")
				console.log("NO TOUR FOUND FOR USER")
				console.log("NO TOUR FOUND FOR USER")
				// Tour does not exist, handle the error or send an appropriate response
				return;
			}

			// Send an invitation or notification to the invitee user
			io.to(inviteeId).emit('tour-contributor-invite', { message: 'You have been invited to contribute to the tour', tour: tour });
		});


		// Event: tour-contributor-add
		socket.on('tour-contributor-add', (payload) => {
			const tour = findTourFromSocketId(socket.id)
			if (!tour) {
				console.log("NO TOUR FOUND FOR USER IN ADD USER AS CONTRIBUTOR")
				return;
			}
			console.log("USER ADDED AS CONTRIBUITOR");
			// Add the contributor to the tour's contributors array
			tour.contributors.push(socket.id);
			tour.users.forEach((user) => {
			});
			// Broadcast the message to all users in the tour, including the new contributor
			io.in(sessionId).emit('tour-contributor-add', { message: 'A new contributor has been added to the tour', tour: tour, user: socket.id });
		});


		// Event: tour-contributor-removed
		socket.on('tour-contributor-removed', (payload) => {
			const tour = findTourFromSocketId(socket.id)
			if (!tour) {
				// Tour does not exist, handle the error or send an appropriate response
				return;
			}
			// Remove the contributor from the tour's contributors array
			const index = tour.contributors.indexOf(contributorId);
			if (index !== -1) {
				tour.contributors.splice(index, 1);
			}

			// Broadcast the message to all users in the tour, including the removed contributor
			io.to(sessionId).emit('tour-contributor-removed', { message: 'A contributor has been removed from the tour', user: socket.id, tour });
		});
		socket.on('tour-guest-add', (payload) => {
			const tour = findTourFromSocketId(socket.id)
			if (!tour) {
				console.log("NO TOUR FOUND FOR USER IN ADD USER AS CONTRIBUTOR")
				return;
			}
			console.log("USER ADDED AS CONTRIBUITOR");
			// Add the contributor to the tour's contributors array
			const existingUser = !!tour.guests.find((socketId) => socketId === socket.id);
			!existingUser && tour.guests.push(socket.id);
			tour.canInviteGuest = tour.guests.length < 4;
			tour.raisedHands = tour.raisedHands.filter(socketId => socketId !== socket.id);
			payload.streamId && (tour.streams[socket.id] = payload.streamId);
			// Broadcast the message to all users in the tour, including the new contributor
			io.in(sessionId).emit('tour-guest-add', { message: 'A new contributor has been added to the tour', tour: tour, user: socket.id });
		});


		// Event: tour-contributor-removed
		socket.on('tour-guest-removed', (payload) => {
			const tour = findTourFromSocketId(socket.id)
			if (!tour) {
				// Tour does not exist, handle the error or send an appropriate response
				return;
			}
			tour.guests = tour.guests.filter(socketId => socketId !== payload.socketId)
			tour.raisedHands = tour.raisedHands.filter(socketId => socketId !== payload.socketId);
			// Broadcast the message to all users in the tour, including the removed contributor
			io.to(sessionId).emit('tour-guest-removed', { message: 'A guest has been removed', user: payload.socketId, tour });
		});
		socket.on('tour-raise-hand', (payload) => {
			const tour = findTourFromSocketId(socket.id)
			if (!tour) {
				// Tour does not exist, handle the error or send an appropriate response
				return;
			}
			const existingUser = !!tour.raisedHands.find((socketId) => socketId === socket.id);
			!existingUser && tour.raisedHands.push(socket.id);
			io.to(sessionId).emit('tour-raise-hand', { message: 'Raised hand', user: socket.id, tour });
		});
		socket.on('tour-raise-hand-remove', (payload) => {
			const tour = findTourFromSocketId(socket.id)
			if (!tour) {
				// Tour does not exist, handle the error or send an appropriate response
				return;
			}
			tour.raisedHands = tour.raisedHands.filter((socketId) => socketId !== socket.id);
			io.to(sessionId).emit('tour-raise-hand-remove', { message: 'Raised hand removed', user: socket.id, tour });
		});

		///NEW TOUR START **END**

		socket.on('disconnect', (reason) => {
			try {
				console.log('disconnect', socket.id, reason);
				logger.error('disconnect', reason);

				let tourId;
				Object.keys(tours).find((tId) => {
					const tour = tours[tId];
					// Check if the user is already in the tour
					if (tour) {
						tour.users = tour.users.filter((socketId) => socketId !== socket.id);
						tour.contributors = tour.contributors.filter((socketId) => socketId !== socket.id);
						tour.guests = tour.guests.filter((socketId) => socketId !== socket.id);
						tour.raisedHands = tour.raisedHands.filter((socketId) => socketId !== socket.id);
						if (tour.streams[socket.id]) {
							delete tour.streams[socket.id];
						}
						io.in(sessionId).emit('tour-left', { message: 'User left the tour', tour: tour, user: sessionIdUserMap[sessionId][userId] });
					}
				})
				// Find the tour that the socket is associated with
				Object.keys(tours).find((tId) => {
					if (tours[tId].owner === socket.id) {
						tourId = tId;
						io.in(sessionId).emit('tour-ended', { message: 'Tour ended', tourId });
						delete tours[tId];
					}
				}
				);

				//Prüfen ob der User noch auf Platz belegt
				if (sessionIdUserMap[sessionId].occupiedSeats && userId) {
					let hasChanged = false;
					for (const [seatId, currentUserId] of Object.entries(sessionIdUserMap[sessionId].occupiedSeats)) {
						if (userId === currentUserId) {
							sessionIdUserMap[sessionId].occupiedSeats[seatId] = null;
							sessionIdUserMap[sessionId].screenShareOccupiedSeats && sessionIdUserMap[sessionId].screenShareOccupiedSeats[seatId] && (sessionIdUserMap[sessionId].screenShareOccupiedSeats[seatId] = null);
							sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats && sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[seatId] && (sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[seatId] = null);
							delete sessionIdUserMap[sessionId];
							hasChanged = true;
						}
					}
					if (hasChanged) {
						io.in(sessionId).emit('message', {
							eventName: 'userChangedSeat',
							userId: userId,
							occupiedSeats: sessionIdUserMap[sessionId].occupiedSeats,
						});
					}
				}
				//Prüfen ob der User noch auf Platz belegt
				if (sessionIdUserMap[sessionId].screenShareOccupiedSeats && userId) {
					let hasChanged = false;
					for (const [seatId, currentUserId] of Object.entries(sessionIdUserMap[sessionId].screenShareOccupiedSeats)) {
						if (userId === currentUserId) {
							sessionIdUserMap[sessionId].screenShareOccupiedSeats[seatId] = null;
							hasChanged = true
						}
					}
					if (hasChanged) {
						io.in(sessionId).emit('message', {
							eventName: 'userChangedScreenShareSeat',
							userId: userId,
							screenShareOccupiedSeats: sessionIdUserMap[sessionId].screenShareOccupiedSeats,
						});
					}
				}
				if (sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats && userId) {
					let hasChanged = false;
					for (const [seatId, currentUserId] of Object.entries(sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats)) {
						if (userId === currentUserId) {
							sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[seatId] = null;
							delete sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats[seatId];
							hasChanged = true
						}
					}
					if (hasChanged) {
						io.in(sessionId).emit('message', {
							eventName: 'tour_userChangedScreenShareSeat',
							userId: userId,
							tour_screenShareOccupiedSeats: sessionIdUserMap[sessionId].tour_screenShareOccupiedSeats,
						});
					}
				}

				console.log('game user map', sessionIdUserMap[sessionId].games)

				if (sessionIdUserMap[sessionId].games && userId) {
					for (const game in sessionIdUserMap[sessionId].games) {
						let userStatus = '';
						if (sessionIdUserMap[sessionId].games[game].visitors.hasOwnProperty(userId)) {
							userStatus = 'visitor';
							delete sessionIdUserMap[sessionId].games[game].visitors[userId];
						}
						if (sessionIdUserMap[sessionId].games[game].players.hasOwnProperty(userId)) {
							userStatus = 'player';
							delete sessionIdUserMap[sessionId].games[game].players[userId];
						}

						console.log('user who left was a ', userStatus);

						userStatus === 'player' && resetPlayer(sessionId, game, userId);

						userStatus && io.in(sessionId).emit('gaming', {
							eventName: 'VISITOR_OR_PLAYER_LEFT',
							userId: userId,
							gameId: game,
							userStatus,
							players: sessionIdUserMap[sessionId].games[game].players,
							gameData: sessionIdUserMap[sessionId].games[game].gameData,
						});
					}
				}

				if (sessionIdUserMap[sessionId].occupiedScreens && userId) {
					let hasChanged = false;
					for (const [seatId, currentUserId] of Object.entries(sessionIdUserMap[sessionId].occupiedScreens)) {
						if (userId === currentUserId) {
							sessionIdUserMap[sessionId].occupiedScreens[seatId] = null;
							hasChanged = true
						}
					}
					if (hasChanged) {
						io.in(sessionId).emit('message', {
							eventName: 'userChangedScreen',
							userId: userId,
							occupiedScreens: sessionIdUserMap[sessionId].occupiedScreens,
						});
					}
				}
				if (sessionIdUserMap[sessionId].lockedRooms && userId) {
					if (sessionIdUserMap[sessionId][userId] && socketHelper.isSceneEmpty(sessionIdUserMap[sessionId], sessionIdUserMap[sessionId][userId].currentSceneId, true)) {
						sessionIdUserMap[sessionId].lockedRooms[currentSceneId] = null;
						delete sessionIdUserMap[sessionId].lockedRooms[currentSceneId];
					}
					io.in(sessionId).emit('message', {
						eventName: 'userLockRoom',
						userId: userId,
						lockedRooms: sessionIdUserMap[sessionId].lockedRooms,
					});
				}

				delete sessionIdUserMap[sessionId][userId];
				delete userIdSocketIdMap[userId];
				delete sockets[socket.id];

				if (worldId && worldId !== '0') {
					changeWorldOnlineUsers(worldId, userId, -1);
				}

				sendMessageToAllWithoutMe(socket, sessionId, {
					eventName: 'sessionDisconnected',
					senderId: userId,
					data: {
						userId: userId,
					},
				});

				// INFORM ALL USERS IN ALL ROOMS - IN CASE THAT THIS USER INITIATED 1:1 VIDEO CALLS (REMOVE UNANSWERED CALL NOTIFICATIONS), OR IF THIS USER WAS A CALL RECEIVER
				io.emit('message', {
					eventName: 'possibleCallInitiatorOrReceiverGotDisconnected', // 'sessionDisconnected_global'
					senderId: userId
				});

			} catch (exception) {
				console.error('connection', socket.id, exception);
				logger.error('connection error', socket.id, exception);
			}
		});

		socket.on('error', (error) => {
			console.error('error', socket.id, error);
			logger.error('error', socket.id, error);
		});
	} catch (exception) {
		console.error('message', socket.id, exception);
	}
});

function sendMessageToOne(socket, sessionId, receiverId, payload) {
	console.log("sendMessageToOne")
	console.log("sendMessageToOne")
	const socketId = userIdSocketIdMap[receiverId];
	if (socketId) {
		if (socket.id === socketId) {
			console.log("sendMessageToOne (myself)", socketId, sessionId, payload);
			socket.emit('message', payload);
		} else {
			console.log("sendMessageToOne (not me)", socketId, sessionId, payload);
			socket.broadcast.to(socketId).emit('message', payload);
		}
	} else {
		console.warn("sendMessageToOne: SocketID zum receiverId " + receiverId + " nicht gefunden.", userIdSocketIdMap);
	}
}

function sendMessageToAllWithoutMe(socket, sessionId, payload) {
	//console.log("sendMessageToAllWithoutMe", socket.id, sessionId, payload);
	socket.to(sessionId).send(payload);
}

function sendMessageToAll(sessionId, payload) {
	//console.log("sendMessageToAll", sessionId, payload);
	io.in(sessionId).send(payload);
}


function updateUserDataFromWordpress(sessionId, userId) {
	request.post('https://bagless.io/wp-json/user_fetch?userId=[' + userId + ']', (error, response, body) => {
		if (error) {
			console.log('updateUserDataFromWordpress ==> Error fetching data:', error);
			return;
		}

		if (body === '"No user found"') {
			console.log('updateUserDataFromWordpress ==> No user found', body);
			return;
		}

		if (response.statusCode < 200 || response.statusCode >= 300) {
			console.log('updateUserDataFromWordpress ==> Unsuccessful fetching data. Statuscode:', response.statusCode);
			return;
		}

		const userData = JSON.parse(body);

		//Ein paar Korrekturen die Raihan nicht ganz korrekt benannt hat:
		userData.userName = userData.name || userData.username || userData.userName;
		delete userData.name;
		delete userData.username;
		userData.userAvatarUrl = userData.avator_image || userData.userAvatarUrl;
		delete userData.avator_image;

		updateUserData(sessionId, userId, userData);
	});
}

function updateUserData(sessionId, userId, newUserData) {
	if (!sessionIdUserMap[sessionId] || !sessionIdUserMap[sessionId][userId]) {
		return;
	}

	sessionIdUserMap[sessionId][userId] = { ...sessionIdUserMap[sessionId][userId], ...newUserData }

	sendMessageToAll(sessionId, {
		eventName: 'userDataUpdated',
		senderId: userId,
		data: sessionIdUserMap[sessionId][userId],
	});
}

function clearOnlineUsersTables() {
	//debugger;
	console.log("clearOnlineUsersTables");

	let dbConnection = null;
	try {
		dbConnection = mysql.createConnection(dbConfig);

		let sql = `TRUNCATE online_users`;
		dbConnection.query(sql, null, (error, results, fields) => {
			if (error) {
				console.error(error.message);
			}
		});
	} catch (exception) {
		console.error("clearOnlineUsersTables: ", exception);
	} finally {
		if (dbConnection) {
			dbConnection.end();
		}
	}
}

function changeWorldOnlineUsers(worldId, userId, relativeUserCount) {
	console.log("changeWorldOnlineUsers", worldId, relativeUserCount);

	let dbConnection = null;
	try {
		dbConnection = mysql.createConnection(dbConfig);

		let sql = `
			INSERT INTO online_users
				(worldId, onlineUsers, lastUpdate)
			VALUES (
				?,
				GREATEST(?, 0),
				UNIX_TIMESTAMP()
			)
			ON DUPLICATE KEY UPDATE
				onlineUsers = GREATEST(onlineUsers + ?, 0),
				lastUpdate = UNIX_TIMESTAMP()
		`;

		dbConnection.query(sql, [worldId, relativeUserCount, relativeUserCount], (error, results, fields) => {
			if (error) {
				console.error(error.message);
			}
		});

	} catch (exception) {
		console.error("changeWorldOnlineUsers: ", exception);
	} finally {
		if (dbConnection) {
			dbConnection.end();
		}
	}
}
function addChatMessage(userId, senderId, message, callback) {
	//debugger;
	console.log("adding chat mesage to db");
	const time = new Date().toISOString().slice(0, 19).replace('T', ' ');
	console.log(time)
	let dbConnection = null;


	try {
		dbConnection = mysql.createConnection(dbConfig);
		const messageString = `{"message":"${message}","timestamp":"${time}","userId":"${userId}","senderId":"${senderId}"},`;
		let sql = `
		UPDATE user_chats
		SET message = concat('${messageString}', message)
		WHERE (userId=${senderId} AND senderId=${userId}) OR (userId=${userId} AND senderId=${senderId})
		`;
		dbConnection.query(sql, [userId, senderId, messageString, time], (error, results, fields) => {
			if (error) {
				console.error(error.message);
			}
			console.log("RESULTS ::::::", results, fields)
			callback && callback()
		});
	} catch (exception) {
		console.error("adding chat mesage to db", exception);
	} finally {
		if (dbConnection) {
			dbConnection.end();
		}
	}
}
function addWorldMessage(senderId, worldId, message, callback) {
	//debugger;
	let dbConnection = null;
	try {
		const time = new Date().toISOString().slice(0, 19).replace('T', ' ');
		dbConnection = mysql.createConnection(dbConfig);
		const sql = `INSERT INTO worlds_chat (sender_id, worldId, message, time) VALUES (${senderId},${worldId}, '${message}', '${time}');`;
		dbConnection.query(sql, [senderId, worldId, message, time], (error, results, fields) => {
			if (error) {
				console.error(error.message);
			}
		});
	} catch (exception) {
		console.error("adding chat mesage to db", exception);
	} finally {
		if (dbConnection) {
			dbConnection.end();
			callback && callback()
		}
	}
}
function addRoomMessage(senderId, roomId, message, callback) {
	//debugger;
	let dbConnection = null;
	try {
		const time = new Date().toISOString().slice(0, 19).replace('T', ' ');
		dbConnection = mysql.createConnection(dbConfig);
		const sql = `INSERT INTO local_chats (sender_id, roomId, message, time) VALUES (${senderId}, '${roomId}', '${message}', '${time}');`;
		console.log(sql);
		dbConnection.query(sql, [senderId, roomId, message, time], (error, results, fields) => {
			if (error) {
				console.error(error.message);
			}
		});
	} catch (exception) {
		console.error("adding chat mesage to db", exception);
	} finally {
		if (dbConnection) {
			dbConnection.end();
			callback && callback()
		}
	}
}

function sliceHistoryChatMessages(userId, senderId, message) {
	console.log("adding chat mesage to db");
	const time = new Date().toISOString().slice(0, 19).replace('T', ' ');
	console.log(time)
	let dbConnection = null;

	try {
		dbConnection = mysql.createConnection(dbConfig);
		let sql = `
			update user_chats
    	set message = '${message}'
    	WHERE (userId=${senderId} AND senderId=${userId}) OR (userId=${userId} AND senderId=${senderId})
		`;
		dbConnection.query(sql, [userId, senderId, message, time], (error, results, fields) => {
			if (error) {
				console.error(error.message);
			}
		});
	} catch (exception) {
		console.error("adding chat mesage to db", exception);
	} finally {
		if (dbConnection) {
			dbConnection.end();
		}
	}
}

function saveInitialMessage(userId, senderId, message, callback) {
	let dbConnection = null;
	try {
		const time = new Date().toISOString().slice(0, 19).replace('T', ' ');
		const messageString = `{"message":"...","timestamp":"${time}","userId":"${userId}","senderId":"${senderId}"}`;
		console.log(messageString, "MESSAGESTRINGGGGGG")
		dbConnection = mysql.createConnection(dbConfig);
		const sql = `INSERT INTO user_chats (userId, senderId, message, time) VALUES (${userId}, ${senderId}, '${messageString}', '${time}');`;
		dbConnection.query(sql, null, (error, results) => {
			if (error) {
				console.error(error.message);
			}
			console.log("initial saved messages")
			callback(results)
		});
	} catch (exception) {
		console.error("getting messages error", exception);
	} finally {
		if (dbConnection) {
			dbConnection.end();
		}
	}
}

function getChatmessages(userId, senderId, messageString, callback) {
	let dbConnection = null;
	try {
		dbConnection = mysql.createConnection(dbConfig);
		let sql = `SELECT message FROM user_chats WHERE (userId=${senderId} AND senderId=${userId}) OR (userId=${userId} AND senderId=${senderId});`
		dbConnection.query(sql, null, (error, results) => {
			if (error) {
				console.error(error.message);
			}
			if (results && results.length === 0) {
				console.log("messages no exits");
				saveInitialMessage(userId, senderId, messageString, callback)
			}
			else {
				const last = results[0].message.charAt(results[0].message.length - 1);
				if (last === ",") {
					results[0].message = results[0].message.slice(0, -1);
				}
				const messages = JSON.parse(`[${results[0].message}]`);
				let copy = [...messages];

				const twentyFourHrInMs = 24 * 60 * 60 * 1000;
				const twentyFourHoursAgo = Date.now() - twentyFourHrInMs;

				messages.forEach((item, index) => {
					const parsedDate = Date.parse(item.timestamp)
					console.log(parsedDate, twentyFourHoursAgo)
					console.log(parsedDate < twentyFourHoursAgo)
					let dataString;
					if (parsedDate < twentyFourHoursAgo) {
						copy = copy.splice(0, index);
						console.log("dataString")
						console.log(dataString)
						console.log("dataString")
						dataString = JSON.stringify(copy).slice(1, -1);
						console.log("dataString")
						console.log(dataString)
						sliceHistoryChatMessages(userId, senderId, dataString);
						results[0].message = dataString;
						return false;
					}
				});
				callback && callback(results)
			}
		});
	} catch (exception) {
		console.error("getting messages error", exception);
	} finally {
		if (dbConnection) {
			dbConnection.end();
		}
	}
}

function resetPlayer(sessionId, gameId, userId) {
	for (const key in sessionIdUserMap[sessionId].games[gameId].gameData) {
		if (key.startsWith('player')) {
			if (sessionIdUserMap[sessionId].games[gameId].gameData[key].hasOwnProperty('profile')) {
				if (sessionIdUserMap[sessionId].games[gameId].gameData[key].profile !== null) {
					if (sessionIdUserMap[sessionId].games[gameId].gameData[key].profile.hasOwnProperty('userId')) {
						if (sessionIdUserMap[sessionId].games[gameId].gameData[key].profile.userId == userId) {
							sessionIdUserMap[sessionId].games[gameId].gameData[key].profile = null;
						}
					}
				}
			}
		}
	}
}


function findTourFromSocketId(socketId) {
	let foundTour = null;
	// Iterate over the tours object
	Object.values(tours).find((tour) => {
		// Check if the users array contains the specified id
		if (tour.users.includes(socketId) || tour.owner === socketId) {
			foundTour = tour; // Set the found tour object
			return foundTour; // Exit the loop
		}
	});
	return foundTour;
}

https.listen(3001, () => {
	console.log('Server started');

});
