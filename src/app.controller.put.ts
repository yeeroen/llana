import { Body, Controller, Headers, Param, Patch, Put, Req, Res } from '@nestjs/common'

import { LLANA_WEBHOOK_TABLE } from './app.constants'
import { HeaderParams } from './dtos/requests.dto'
import { FindOneResponseObject, IsUniqueResponse, UpdateManyResponseObject } from './dtos/response.dto'
import { Authentication } from './helpers/Authentication'
import { UrlToTable } from './helpers/Database'
import { Query } from './helpers/Query'
import { Response } from './helpers/Response'
import { Roles } from './helpers/Roles'
import { Schema } from './helpers/Schema'
import { Webhook } from './helpers/Webhook'
import { DataCacheService } from './modules/cache/dataCache.service'
import { WebsocketService } from './modules/websocket/websocket.service'
import { AuthTablePermissionFailResponse, AuthTablePermissionSuccessResponse } from './types/auth.types'
import { DataSourceSchema, DataSourceWhere, PublishType, QueryPerform, WhereOperator } from './types/datasource.types'
import { RolePermission } from './types/roles.types'

@Controller()
export class PutController {
	constructor(
		private readonly authentication: Authentication,
		private readonly dataCache: DataCacheService,
		private readonly query: Query,
		private readonly response: Response,
		private readonly roles: Roles,
		private readonly schema: Schema,
		private readonly websocket: WebsocketService,
		private readonly webhooks: Webhook,
	) {}

	@Put('*/:id')
	async updateById(
		@Req() req,
		@Res() res,
		@Body() body: Partial<any>,
		@Headers() headers: HeaderParams,
		@Param('id') id: string,
	): Promise<FindOneResponseObject> {
		const x_request_id = headers['x-request-id']
		let table_name = UrlToTable(req.originalUrl, 1)

		if (table_name === 'webhook') {
			table_name = LLANA_WEBHOOK_TABLE
		}

		let schema: DataSourceSchema
		let queryFields = []

		try {
			schema = await this.schema.getSchema({ table: table_name, x_request_id })
		} catch (e) {
			return res.status(404).send(this.response.text(e.message))
		}

		// Is the table public?
		const public_auth = await this.authentication.public({
			table: table_name,
			access_level: RolePermission.WRITE,
			x_request_id,
		})

		if (public_auth.valid && public_auth.allowed_fields?.length) {
			if (!queryFields?.length) {
				queryFields = public_auth.allowed_fields
			} else {
				queryFields = queryFields.filter(field => public_auth.allowed_fields.includes(field))
			}
		}

		// If not public, perform auth

		const auth = await this.authentication.auth({
			table: table_name,
			x_request_id,
			access: RolePermission.WRITE,
			headers: req.headers,
			body: req.body,
			query: req.query,
		})
		if (!public_auth.valid && !auth.valid) {
			return res.status(401).send(this.response.text(auth.message))
		}

		//validate input data
		const validate = await this.schema.validateData(schema, body)
		if (!validate.valid) {
			return res.status(400).send(this.response.text(validate.message))
		}

		//validate :id field
		const primary_key = this.schema.getPrimaryKey(schema)

		if (!primary_key) {
			return res.status(400).send(this.response.text(`No primary key found for table ${table_name}`))
		}

		const validateKey = await this.schema.validateData(schema, { [primary_key]: id })
		if (!validateKey.valid) {
			return res.status(400).send(this.response.text(validateKey.message))
		}

		//validate uniqueness
		try {
			const uniqueValidation = (await this.query.perform(
				QueryPerform.UNIQUE,
				{
					schema,
					data: body,
					id: id,
				},
				x_request_id,
			)) as IsUniqueResponse

			if (!uniqueValidation.valid) {
				return res.status(400).send({
					message: uniqueValidation.message,
					error: uniqueValidation.error,
				})
			}
		} catch (e) {
			if (process.env.NODE_ENV === 'test') {
				console.warn(`[Test Environment] Skipping uniqueness check: ${e.message}`)
			} else {
				return res.status(400).send({
					message: 'Error checking record uniqueness',
					error: e.message,
				})
			}
		}

		const where = <DataSourceWhere[]>[
			{
				column: primary_key,
				operator: WhereOperator.equals,
				value: id,
			},
		]

		//Check record exists

		const record = (await this.query.perform(
			QueryPerform.FIND_ONE,
			{
				schema,
				where,
			},
			x_request_id,
		)) as FindOneResponseObject

		if (!record) {
			return res.status(400).send(this.response.text(`Record with id ${id} not found`))
		}

		// If not public, perform auth
		if (auth.user_identifier) {
			const permission = await this.roles.tablePermission({
				identifier: auth.user_identifier,
				table: table_name,
				access: RolePermission.WRITE,
				data: record,
				x_request_id,
			})

			if (!public_auth.valid && !permission.valid) {
				return res.status(401).send(this.response.text((permission as AuthTablePermissionFailResponse).message))
			}

			if (permission.valid && (permission as AuthTablePermissionSuccessResponse).allowed_fields?.length) {
				if (!queryFields?.length) {
					queryFields = (permission as AuthTablePermissionSuccessResponse).allowed_fields
				} else {
					queryFields.push(...(permission as AuthTablePermissionSuccessResponse).allowed_fields)
					queryFields = queryFields.filter(field =>
						(permission as AuthTablePermissionSuccessResponse).allowed_fields.includes(field),
					)
				}
			}
		}

		try {
			const result = await this.query.perform(
				QueryPerform.UPDATE,
				{ id, schema, data: validate.instance },
				x_request_id,
			)
			await this.websocket.publish(schema, PublishType.UPDATE, result[schema.primary_key])
			await this.webhooks.publish(schema, PublishType.UPDATE, result[schema.primary_key], auth.user_identifier)

			await this.dataCache.ping(table_name)

			if (queryFields.length) {
				const filtered = {}
				for (const field of queryFields) {
					filtered[field] = result[field]
				}
				return res.status(200).send(filtered)
			}

			return res.status(200).send(result)
		} catch (e) {
			return res.status(400).send(this.response.text(e.message))
		}
	}

	@Put('*/')
	async updateMany(
		@Req() req,
		@Res() res,
		@Body() body: any,
		@Headers() headers: HeaderParams,
	): Promise<UpdateManyResponseObject> {
		const x_request_id = headers['x-request-id']
		let table_name = UrlToTable(req.originalUrl, 1)

		if (table_name === 'webhook') {
			table_name = LLANA_WEBHOOK_TABLE
		}

		let schema: DataSourceSchema
		let queryFields = []

		try {
			schema = await this.schema.getSchema({ table: table_name, x_request_id })
		} catch (e) {
			return res.status(404).send(this.response.text(e.message))
		}

		// Is the table public?
		const public_auth = await this.authentication.public({
			table: table_name,
			access_level: RolePermission.WRITE,
			x_request_id,
		})

		if (public_auth.valid && public_auth.allowed_fields?.length) {
			if (!queryFields?.length) {
				queryFields = public_auth.allowed_fields
			} else {
				queryFields = queryFields.filter(field => public_auth.allowed_fields.includes(field))
			}
		}

		// If not public, perform auth

		const auth = await this.authentication.auth({
			table: table_name,
			x_request_id,
			access: RolePermission.WRITE,
			headers: req.headers,
			body: req.body,
			query: req.query,
		})
		if (!public_auth.valid && !auth.valid) {
			return res.status(401).send(this.response.text(auth.message))
		}

		//validate :id field
		const primary_key = this.schema.getPrimaryKey(schema)

		if (!primary_key) {
			return res.status(400).send(this.response.text(`No primary key found for table ${table_name}`))
		}

		if (!(body instanceof Array)) {
			return res.status(400).send(this.response.text('Body must be an array'))
		}
		const total = body.length
		let successful = 0
		let errored = 0
		const errors = []
		const data: FindOneResponseObject[] = []

		for (const item of body) {
			//validate input data
			const validate = await this.schema.validateData(schema, item)
			if (!validate.valid) {
				errored++
				errors.push({
					item: body.indexOf(item),
					message: validate.message,
				})
				continue
			}

			const validateKey = await this.schema.validateData(schema, { [primary_key]: item[primary_key] })
			if (!validateKey.valid) {
				errored++
				errors.push({
					item: body.indexOf(item),
					message: validateKey.message,
				})
				continue
			}

			//validate uniqueness
			try {
				const uniqueValidation = (await this.query.perform(
					QueryPerform.UNIQUE,
					{
						schema,
						data: item,
						id: item[primary_key],
					},
					x_request_id,
				)) as IsUniqueResponse

				if (!uniqueValidation.valid) {
					errored++
					errors.push({
						item: body.indexOf(item),
						message: uniqueValidation.message,
						error: uniqueValidation.error,
					})
					continue
				}
			} catch (e) {
				if (process.env.NODE_ENV === 'test') {
					console.warn(`[Test Environment] Skipping uniqueness check: ${e.message}`)
				} else {
					errored++
					errors.push({
						item: body.indexOf(item),
						message: 'Error checking record uniqueness',
						error: e.message,
					})
					continue
				}
			}

			const where = <DataSourceWhere[]>[
				{
					column: primary_key,
					operator: WhereOperator.equals,
					value: item[primary_key],
				},
			]

			//Check record exists

			const record = (await this.query.perform(
				QueryPerform.FIND_ONE,
				{
					schema,
					where,
				},
				x_request_id,
			)) as FindOneResponseObject

			if (!record) {
				errored++
				errors.push({
					item: body.indexOf(item),
					message: `Record with id ${item[primary_key]} not found`,
				})
				continue
			}

			//Perform role validation on each record
			if (auth.user_identifier) {
				const permission = await this.roles.tablePermission({
					identifier: auth.user_identifier,
					table: table_name,
					access: RolePermission.WRITE,
					data: {
						...record,
						...item,
					},
					x_request_id,
				})

				if (!public_auth.valid && !permission.valid) {
					errored++
					errors.push({
						item: body.indexOf(item),
						message: this.response.text((permission as AuthTablePermissionFailResponse).message),
					})
					continue
				}

				if (permission.valid && (permission as AuthTablePermissionSuccessResponse).allowed_fields?.length) {
					if (!queryFields?.length) {
						queryFields = (permission as AuthTablePermissionSuccessResponse).allowed_fields
					} else {
						queryFields.push(...(permission as AuthTablePermissionSuccessResponse).allowed_fields)
						queryFields = queryFields.filter(field =>
							(permission as AuthTablePermissionSuccessResponse).allowed_fields.includes(field),
						)
					}
				}
			}

			try {
				const result = (await this.query.perform(
					QueryPerform.UPDATE,
					{ id: item[primary_key], schema, data: validate.instance },
					x_request_id,
				)) as FindOneResponseObject
				await this.websocket.publish(schema, PublishType.UPDATE, result[schema.primary_key])
				await this.webhooks.publish(
					schema,
					PublishType.UPDATE,
					result[schema.primary_key],
					auth.user_identifier,
				)
				successful++

				if (queryFields.length) {
					const filtered = {}
					for (const field of queryFields) {
						filtered[field] = result[field]
					}
					data.push(filtered)
					continue
				}

				data.push(result)
			} catch (e) {
				errored++
				errors.push({
					item: body.indexOf(item),
					message: e.message,
				})
				continue
			}
		}

		await this.dataCache.ping(table_name)

		return res.status(200).send({
			total,
			successful,
			errored,
			errors,
			data,
		} as UpdateManyResponseObject)
	}

	@Patch('*/:id')
	async updateByIdPatch(
		@Req() req,
		@Res() res,
		@Body() body: Partial<any>,
		@Headers() headers: HeaderParams,
		@Param('id') id: string,
	): Promise<FindOneResponseObject> {
		return await this.updateById(req, res, body, headers, id)
	}

	@Patch('*/')
	async updateManyPatch(
		@Req() req,
		@Res() res,
		@Body() body: any,
		@Headers() headers: HeaderParams,
	): Promise<UpdateManyResponseObject> {
		return await this.updateMany(req, res, body, headers)
	}
}
