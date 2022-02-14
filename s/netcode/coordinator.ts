
import {Await} from "dbmage"

import {Delta} from "./world/types.js"
import {makeWorld} from "./world/world.js"
import {makeGame} from "../game/make-game.js"
import {makeNetworking} from "./networking.js"
import {RemotePromise, remotePromise} from "./utils/remote-promise.js"
import {AnyEntityDescription, Entity, EntityDescription, Spawner} from "../game/types.js"
import {ChangesUpdate, ClientNetworking, DescriptionUpdate, HostNetworking, RequestUpdate, Update, UpdateType} from "./types.js"

export function makeCoordinator({game, networking}: {
		game: Await<ReturnType<typeof makeGame>>
		networking: Await<ReturnType<typeof makeNetworking>>
	}) {

	const world = makeWorld<EntityDescription>()
	const entities = new Map<string, Entity>()
	const pendingEntitySpawns = new Set<string>()
	const pendingAddToWorld = new Map<string, RemotePromise<Entity>>()
	const spawnListeners = new Set<(data: {
		id: string
		entity: Entity
		description: EntityDescription
	}) => void>()

	function hasEntityBeenAdded(id: string) {
		return entities.has(id) || pendingEntitySpawns.has(id)
	}

	// high-frequency network loop
	const networkLoop = new Set<() => void>()
	setInterval(() => {
		for (const loop of networkLoop)
			loop()
	}, 16.6667)

	// lower-frequency network loop
	const slowNetworkLoop = new Set<() => void>()
	setInterval(() => {
		for (const loop of slowNetworkLoop)
			loop()
	}, 100)

	// replication of the world as game entities
	networkLoop.add(function replicate() {
		for (const [id, description] of world.readAllDescriptions()) {
			if (hasEntityBeenAdded(id)) {
				const entity = entities.get(id)
				if (entity) {
					if (description) {
						if (!networking.host)
							entity.update(description)
					}
					else {
						console.log(`entity removed "${id}"`)
						entity.dispose()
						entities.delete(id)
					}
				}
			}
			else {
				const {type} = description
				const spawner = <Spawner<EntityDescription>>game.spawn[type]
				if (spawner) {
					console.log(`adding entity "${type}"`)
					pendingEntitySpawns.add(id)
					const addToWorldOperation = pendingAddToWorld.get(id)
					spawner({
							host: networking.host,
							description: <any>description,
						})
						.then(entity => {
							entities.set(id, entity)
							entity.update(world.readDescriptions(id)[0])
							if (addToWorldOperation)
								addToWorldOperation.resolve(entity)
							for (const listener of spawnListeners)
								listener({id, description, entity})
						})
						.catch(error => {
							console.error(error)
							if (addToWorldOperation)
								addToWorldOperation.reject(error)
						})
						.finally(() => {
							pendingEntitySpawns.delete(id)
							pendingAddToWorld.delete(id)
						})
				}
				else {
					console.error(`unknown entity type "${type}"`)
				}
			}
		}
	})

	const hostNet = <HostNetworking>networking
	const clientNet = <ClientNetworking>networking
	const requestListeners = new Set<(clientId: string, update: RequestUpdate) => void>()

	if (networking.host) {

		// update the world with entity changes
		networkLoop.add(function describeEntities() {
			world.updateDescriptions(
				...[...entities]
					.map(([id, entity]) => <[string, Delta<EntityDescription>]>[
						id,
						entity.describe()
					])
			)
		})

		// force full whole-entity description updates,
		// sending only one description at a time,
		// so as to eventually update everything in the world
		// that could have missed deltas due to packet loss
		let descriptionIndex = 0
		slowNetworkLoop.add(function broadcastDescriptions() {
			const allDescriptions = world.readAllDescriptions()
			if (descriptionIndex > allDescriptions.length - 1)
				descriptionIndex = 0
			const [id, description] = allDescriptions[descriptionIndex]
			hostNet.sendToAllClients(<DescriptionUpdate>[
				UpdateType.Description,
				[id, description],
			])
			descriptionIndex += 1
		})

		// routinely send all world changes
		networkLoop.add(function broadcastAllChanges() {
			const changes = world.extractAllChanges()
			hostNet.sendToAllClients(<ChangesUpdate>[
				UpdateType.Changes,
				changes,
			])
		})

		// host listens for incoming requests
		hostNet.receivers.add((clientId, update: Update) => {
			if (update[0] === UpdateType.Request) {
				for (const listener of requestListeners)
					listener(clientId, update)
			}
		})

	}
	else {

		// client listens for incoming changes
		clientNet.receivers.add(([type, data]: Update) => {
			if (type === UpdateType.Description) {
				const [id, description] = <DescriptionUpdate[1]>data
				world.assertDescription(id, description)
			}
			else if (type === UpdateType.Changes) {
				const changes = <ChangesUpdate[1]>data
				world.applyAllChanges(changes)
			}
		})
	}

	return {
		isGameHost: networking.host,
		getPlayerId: networking.getPlayerId,
		spawnListeners,
		host: networking.host
			? {
				requestListeners,
				async addToWorld(...descriptions: AnyEntityDescription[]) {
					return Promise.all(descriptions.map(description => {
						const remote = remotePromise<Entity>()
						const [id] = world.createDescriptions(description)
						pendingAddToWorld.set(id, remote)
						return remote.promise
					}))
				},
				removeFromWorld(ids: string[]) {
					world.deleteDescriptions(...ids)
					for (const id of ids) {
						const entity = entities.get(id)
						entity.dispose()
						entities.delete(id)
					}
				},
			}
			: undefined,
		client: !networking.host
			? {
				sendRequest(data: any) {
					clientNet.sendToHost(<RequestUpdate>[
						UpdateType.Request,
						data,
					])
				},
			}
			: undefined,
	}
}
