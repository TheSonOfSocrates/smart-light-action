/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';
const {google} = require('googleapis');
const util = require('util');
const express = require('express');
const app = express();

const homegraph = google.homegraph({
	version: 'v1',
	auth: new google.auth.GoogleAuth({
		keyFile: './key.json',
		scopes: ['https://www.googleapis.com/auth/homegraph']
	})
});


// should be in database
let global_state = false;
const client_id = 'sgvsvsv';
const client_secret = 'abc';
const auth_code = 'xxxxxx';
const atoken = '123access';
const rtoken = '123refresh';
const UserId = '9ru93yutr93e9tp';

const update_state = async (onlines, val, deviceId) => {
	global_state = val;
	const res = await homegraph.devices.reportStateAndNotification({
		requestBody: {
			agentUserId: UserId,
			requestId: Math.random().toString(),
			payload: {
				devices: {
					states: {
						[deviceId]: {
							on: global_state,
							online:onlines
						}
					}
				}
			}
		}
	});
};

app.get('/test', function(request, response) {
	console.log(request.query.on == 'true')
	update_state(true,request.query.on == 'true','light');
	response.end()
});

// checks header for valid token needs to be done by user, but its only me
const check_headers = (headers) => {
	return headers.authorization.split(" ").pop() == atoken
}

const queryDevice = async (deviceId) => {
	return {
		online: true,
		on: global_state
	};
}

const updateDevice = async (execution,deviceId) => {
	const {params,command} = execution;
	switch (command) {
		case 'action.devices.commands.OnOff':
			global_state = {on: params.on};
			break;
	}
	console.log(global_state.on)

	return global_state;
}

app.get('/fakeauth', (request, response) => {
	const HTTP_STATUS_UNAUTHORIZED = 401;
	response.setHeader('content-type','application/json;charset=utf-8')
	const responseurl = util.format('%s?code=%s&state=%s',
		decodeURIComponent(request.query.redirect_uri), auth_code,
		request.query.state);
	const google_host = (new URL(decodeURIComponent(request.query.redirect_uri))).hostname;
	if(google_host == "oauth-redirect.googleusercontent.com" || google_host == "oauth-redirect-sandboxgoogleusercontent.com"){
		response.redirect(responseurl);
		return;
	}
	response.status(HTTP_STATUS_UNAUTHORIZED);
	return
});

app.post('/faketoken',  (request, response) => {
	console.log(request.query)
	const grantType = request.query.grant_type
		? request.query.grant_type : request.body.grant_type;
	const secondsInDay = 86400; // 60 * 60 * 24
	const HTTP_STATUS_OK = 200;
	const HTTP_STATUS_UNAUTHORIZED = 401;

	if(request.body.client_id !== client_id || request.body.client_secret !== client_secret)
		response.status(HTTP_STATUS_UNAUTHORIZED);

	if(request.body.authorization_code !== auth_code)
		response.status(HTTP_STATUS_UNAUTHORIZED);

	let obj;
	if (grantType === 'authorization_code') {
		obj = {
			token_type: 'bearer',
			access_token: atoken,
			refresh_token: rtoken,
			expires_in: secondsInDay,
		};
	} else if (grantType === 'refresh_token') {
		if(request.body.authorization_code != rtoken)
			response.status(HTTP_STATUS_UNAUTHORIZED);
		obj = {
			token_type: 'bearer',
			access_token: atoken,
			expires_in: secondsInDay,
		};
	}
	response.status(HTTP_STATUS_OK)
		.json(obj);
});


const onDisconnect = () => {
	return {}
}

const onSync = (body) => {
	return {
		requestId: body.requestId,
		payload: {
			agentUserId: UserId,
			devices: [{
				id: 'light',
				type: 'action.devices.types.LIGHT',
				traits: [
					'action.devices.traits.OnOff',
				],
				name: {
					defaultNames: ['Kitchen light'],
					name: 'kitchen light',
					nicknames: ['light'],
				},
				willReportState: true,
			}],
		},
	};
}


const onQuery = async (body) => {
	const {requestId} = body;
	const payload = {
		devices: {},
	};
	const queryPromises = [];
	const intent = body.inputs[0];
	for (const device of intent.payload.devices) {
		const deviceId = device.id;
		queryPromises.push(queryDevice(deviceId)
		.then((data) => {
			payload.devices[deviceId] = data;
		},
		));
	}
	await Promise.all(queryPromises)
	return {
		requestId: requestId,
		payload: payload,
	};
}


const onExecute = async (body) => {
	const {requestId} = body;
	// Execution results are grouped by status
	const result = {
		ids: [],
		status: 'SUCCESS',
		states: {
			online: true,
		},
	};

	const executePromises = [];
	const intent = body.inputs[0];
	for (const command of intent.payload.commands) {
		for (const device of command.devices) {
			for (const execution of command.execution) {
				executePromises.push(
					updateDevice(execution,device.id)
						.then((data) => {
							result.ids.push(device.id);
							Object.assign(result.states, data);
						})
						.catch(() => console.error(`Unable to update ${device.id}`))
				);
			}
		}
	}

	await Promise.all(executePromises)
	return {
		requestId: requestId,
		payload: {
			commands: [result],
		},
	};
}



app.post('/smarthome', async (request, response) => {
	if (!check_headers(request.headers))
		return response.status(401);
	const command = request.body.inputs[0].intent;
	console.log(command)
	let body = {};
	switch (command) {
		case 'action.devices.EXECUTE':
			body = await onExecute(request.body);
		break;
		case 'action.devices.SYNC':
			body = onSync(request.body);
		break;
		case 'action.devices.QUERY':
			body = await onQuery(request.body);
		break;
		case 'action.devices.DISSCONNECT':
			body = onDisconnect(request.body);
		break;
	}
	response.setHeader('content-type','application/json;charset=utf-8')
	response.status(200).send(body);
});

app.get('/requestsync', async function(request, response) {
	response.set('Access-Control-Allow-Origin', '*');
	try {
		const res = await homegraph.devices.requestSync({
			requestBody: {
				agentUserId: UserId
			}
		});
	} catch (err) {
		console.error(err);
		response.status(500).send(`Error requesting sync: ${err}`)
	}
});
app.listen(8080);
