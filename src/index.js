/* eslint-disable no-nested-ternary */
const core = require('@actions/core')
const Github = require('./github')
const Vercel = require('./vercel')
const { addSchema } = require('./helpers')
const crypto = require('crypto')

const {
	GITHUB_DEPLOYMENT,
	USER,
	REPOSITORY,
	BRANCH,
	PR_NUMBER,
	SHA,
	IS_PR,
	PR_LABELS,
	CREATE_COMMENT,
	COMMENT_TITLE,
	PR_PREVIEW_DOMAIN,
	ALIAS_DOMAINS,
	ATTACH_COMMIT_METADATA,
	LOG_URL,
	DEPLOY_PR_FROM_FORK,
	IS_FORK,
	ACTOR
} = require('./config')

// Following https://perishablepress.com/stop-using-unsafe-characters-in-urls/ only allow characters that won't break the URL.
const urlSafeParameter = (input) => input.replace(/[^a-z0-9_~]/gi, '-')

const run = async () => {
	async function updateComment({ previewUrl, inspectUrl, error }) {
		if (IS_PR) {
			if (CREATE_COMMENT) {
				core.info('Creating/updating comment on PR')
				const titleSection = COMMENT_TITLE ? `## ${ COMMENT_TITLE }\n\n` : ''
				const body = `
					${ titleSection }This pull request is being deployed to Vercel.

					<table>
						<tr>
							<td><strong>Latest commit:</strong></td>
							<td><code>${ SHA.substring(0, 7) }</code></td>
						</tr>
						<tr>
							<td><strong>${ error ? '🔴' : previewUrl ? '✅' : '🟨' } Preview:</strong></td>
							<td>${ error ? '*Error*' : (previewUrl ? `<a target='_blank' href='${ previewUrl }'>${ previewUrl }</a>` : '*Pending*') }</td>
						</tr>
						<tr>
							<td><strong>🔍 Inspect:</strong></td>
							<td>${ error ? '*Error*' : (inspectUrl ? `<a target='_blank' href='${ inspectUrl }'>${ inspectUrl }</a>` : '*Pending*') }</td>
						</tr>
					</table>

					[View Workflow Logs](${ LOG_URL })
				`

				const comment = await github.upsertComment(body)
				core.info(`Comment created: ${ comment.html_url }`)
			}
		}
	}


	const github = Github.init()

	// Refuse to deploy an untrusted fork
	if (IS_FORK === true && DEPLOY_PR_FROM_FORK === false) {
		core.warning(`PR is from fork and DEPLOY_PR_FROM_FORK is set to false`)
		const body = `
			Refusing to deploy this Pull Request to Vercel because it originates from @${ ACTOR }'s fork.

			**@${ USER }** To allow this behaviour set \`DEPLOY_PR_FROM_FORK\` to true ([more info](https://github.com/BetaHuhn/deploy-to-vercel-action#deploying-a-pr-made-from-a-fork-or-dependabot)).
		`

		// Use upsertComment for consistency, with DELETE_EXISTING_COMMENT flag
		const comment = await github.upsertComment(body)
		core.info(`Comment created: ${ comment.html_url }`)

		core.setOutput('DEPLOYMENT_CREATED', false)
		core.setOutput('COMMENT_CREATED', true)

		core.info('Done')
		return
	}

	if (GITHUB_DEPLOYMENT) {
		core.info('Creating GitHub deployment')
		const ghDeployment = await github.createDeployment()

		core.info(`Deployment #${ ghDeployment.id } created`)

		await github.updateDeployment('pending')
		core.info(`Deployment #${ ghDeployment.id } status changed to "pending"`)
	}

	await updateComment({})

	try {
		core.info(`Creating deployment with Vercel CLI`)
		const vercel = Vercel.init()

		const commit = ATTACH_COMMIT_METADATA ? await github.getCommit() : undefined
		const deploymentUrl = await vercel.deploy(commit)

		core.info('Successfully deployed to Vercel!')

		const deploymentUrls = []
		if (IS_PR && PR_PREVIEW_DOMAIN) {
			core.info(`Assigning custom preview domain to PR`)

			if (typeof PR_PREVIEW_DOMAIN !== 'string') {
				throw new Error(`invalid type for PR_PREVIEW_DOMAIN`)
			}

			const alias = PR_PREVIEW_DOMAIN.replace('{USER}', urlSafeParameter(USER))
				.replace('{REPO}', urlSafeParameter(REPOSITORY))
				.replace('{BRANCH}', urlSafeParameter(BRANCH))
				.replace('{PR}', PR_NUMBER)
				.replace('{SHA}', SHA.substring(0, 7))
				.toLowerCase()

			const previewDomainSuffix = '.vercel.app'
			let nextAlias = alias


			if (alias.endsWith(previewDomainSuffix)) {
				let prefix = alias.substring(0, alias.indexOf(previewDomainSuffix))

				if (prefix.length >= 60) {
					core.warning(`The alias ${ prefix } exceeds 60 chars in length, truncating using vercel's rules. See https://vercel.com/docs/concepts/deployments/automatic-urls#automatic-branch-urls`)
					prefix = prefix.substring(0, 55)
					const uniqueSuffix = crypto.createHash('sha256')
						.update(`git-${ BRANCH }-${ REPOSITORY }`)
						.digest('hex')
						.slice(0, 6)

					nextAlias = `${ prefix }-${ uniqueSuffix }${ previewDomainSuffix }`
					core.info(`Updated domain alias: ${ nextAlias }`)
				}
			}

			await vercel.assignAlias(nextAlias)
			deploymentUrls.push(addSchema(nextAlias))
		}

		if (!IS_PR && ALIAS_DOMAINS) {
			core.info(`Assigning custom domains to Vercel deployment`)

			if (!Array.isArray(ALIAS_DOMAINS)) {
				throw new Error(`invalid type for PR_PREVIEW_DOMAIN`)
			}

			for (let i = 0; i < ALIAS_DOMAINS.length; i++) {
				const alias = ALIAS_DOMAINS[i]
					.replace('{USER}', urlSafeParameter(USER))
					.replace('{REPO}', urlSafeParameter(REPOSITORY))
					.replace('{BRANCH}', urlSafeParameter(BRANCH))
					.replace('{SHA}', SHA.substring(0, 7))
					.toLowerCase()

				await vercel.assignAlias(alias)

				deploymentUrls.push(addSchema(alias))
			}
		}

		deploymentUrls.push(addSchema(deploymentUrl))
		const previewUrl = deploymentUrls[0]

		let deployment
		try {
			deployment = await vercel.getDeployment()
		} catch (err) {
			await updateComment({ error: true })
			throw err
		}

		core.info(`Deployment "${ deployment.id }" available at: ${ deploymentUrls.join(', ') }`)

		if (GITHUB_DEPLOYMENT) {
			core.info('Changing GitHub deployment status to "success"')
			await github.updateDeployment('success', previewUrl)
		}


		await updateComment({ previewUrl, inspectUrl: deployment.inspectorUrl })

		if (IS_PR && PR_LABELS) {
			core.info('Adding label(s) to PR')
			const labels = await github.addLabel()

			core.info(`Label(s) "${ labels.map((label) => label.name).join(', ') }" added`)
		}

		core.setOutput('PREVIEW_URL', previewUrl)
		core.setOutput('DEPLOYMENT_URLS', deploymentUrls)
		core.setOutput('DEPLOYMENT_UNIQUE_URL', deploymentUrls[deploymentUrls.length - 1])
		core.setOutput('DEPLOYMENT_ID', deployment.id)
		core.setOutput('DEPLOYMENT_INSPECTOR_URL', deployment.inspectorUrl)
		core.setOutput('DEPLOYMENT_CREATED', true)
		core.setOutput('COMMENT_CREATED', IS_PR && CREATE_COMMENT)

		core.info('Done')
	} catch (err) {
		await github.updateDeployment('failure')
		core.setFailed(err.message)
	}
}

run()
	.then(() => {})
	.catch((err) => {
		core.error('ERROR')
		core.setFailed(err.message)
	})