const github = require('@actions/github')
const core = require('@actions/core')

const {
	GITHUB_TOKEN,
	USER,
	REPOSITORY,
	PRODUCTION,
	PR_NUMBER,
	REF,
	LOG_URL,
	PR_LABELS,
	GITHUB_DEPLOYMENT_ENV,
	VERCEL_PROJECT_ID,
	DELETE_EXISTING_COMMENT
} = require('./config')

const init = () => {
	const client = github.getOctokit(GITHUB_TOKEN, { previews: [ 'flash', 'ant-man' ] })

	let deploymentId

	const createDeployment = async () => {
		const deployment = await client.repos.createDeployment({
			owner: USER,
			repo: REPOSITORY,
			ref: REF,
			required_contexts: [],
			environment: GITHUB_DEPLOYMENT_ENV || (PRODUCTION ? 'Production' : 'Preview'),
			description: 'Deploy to Vercel',
			auto_merge: false
		})

		deploymentId = deployment.data.id

		return deployment.data
	}

	const updateDeployment = async (status, url) => {
		if (!deploymentId) return

		const deploymentStatus = await client.repos.createDeploymentStatus({
			owner: USER,
			repo: REPOSITORY,
			deployment_id: deploymentId,
			state: status,
			log_url: LOG_URL,
			environment_url: url || LOG_URL,
			description: 'Starting deployment to Vercel'
		})

		return deploymentStatus.data
	}

	const upsertComment = async (body) => {
		// Add project ID marker for deduplication
		const projectIdMarker = `<!-- vercel-deployment-project-id: ${ VERCEL_PROJECT_ID } -->`

		// Remove indentation from the body
		const cleanBody = body.replace(/^[^\S\n]+/gm, '')

		// Prepend the marker to the body (it will be invisible in the rendered comment)
		const bodyWithMarker = `${ projectIdMarker }\n${ cleanBody }`

		if (DELETE_EXISTING_COMMENT) {
			// Find and delete existing comment for this project
			const { data } = await client.issues.listComments({
				owner: USER,
				repo: REPOSITORY,
				issue_number: PR_NUMBER
			})

			if (data.length > 0) {
				const existingComment = data.find((comment) =>
					comment.body.includes(projectIdMarker)
				)

				if (existingComment) {
					await client.issues.deleteComment({
						owner: USER,
						repo: REPOSITORY,
						comment_id: existingComment.id
					})

					core.info(`Deleted existing comment #${ existingComment.id }`)
				}
			}
		}

		// Create the new comment
		const comment = await client.issues.createComment({
			owner: USER,
			repo: REPOSITORY,
			issue_number: PR_NUMBER,
			body: bodyWithMarker
		})

		return comment.data
	}


	const addLabel = async () => {
		const label = await client.issues.addLabels({
			owner: USER,
			repo: REPOSITORY,
			issue_number: PR_NUMBER,
			labels: PR_LABELS
		})

		return label.data
	}

	const getCommit = async () => {
		const { data } = await client.repos.getCommit({
			owner: USER,
			repo: REPOSITORY,
			ref: REF
		})

		return {
			authorName: data.commit.author.name,
			authorLogin: data.author.login,
			commitMessage: data.commit.message
		}
	}

	return {
		client,
		createDeployment,
		updateDeployment,
		upsertComment,
		addLabel,
		getCommit
	}
}

module.exports = {
	init
}