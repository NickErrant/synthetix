'use strict';

const fs = require('fs');
const path = require('path');
const { gray, yellow, red, cyan } = require('chalk');
const w3utils = require('web3-utils');

const { loadCompiledFiles } = require('../solidity');
const Deployer = require('../Deployer');

const {
	CONFIG_FILENAME,
	COMPILED_FOLDER,
	DEPLOYMENT_FILENAME,
	BUILD_FOLDER,
} = require('../constants');

const {
	toBytes4,
	ensureNetwork,
	ensureDeploymentPath,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	stringify,
} = require('../util');

/**
 * Run a single transaction step, first checking to see if the value needs
 * changing at all, and then whether or not its the owner running it.
 */
const runStep = async ({
	action,
	target,
	read,
	readArg,
	expected,
	write,
	writeArg,
	account,
	gasLimit,
	gasPrice,
	etherscanLinkPrefix,
}) => {
	// check to see if action required
	const response = await target.methods[read](readArg).call();

	console.log(gray(`Attempting action: ${action}`));

	if (expected(response)) {
		console.log(gray(`Nothing required for this action.`));
		return;
	}

	// otherwuse check the owner
	const owner = await target.methods.owner().call();
	if (owner === account) {
		// perform action
		await target.methods[write](writeArg).send({
			from: account,
			gas: Number(gasLimit),
			gasPrice: w3utils.toWei(gasPrice.toString(), 'gwei'),
		});

		console.log(gray(`Successfully completed ${action}`));
	} else {
		// wait for user to perform it
		await confirmAction(
			yellow(
				`YOUR TASK: Invoke ${write}(${writeArg}) via ${etherscanLinkPrefix}/address/${
					target.options.address
				}#writeContract`
			) + '\nPlease enter Y when the transaction has been mined and not earlier. '
		);
	}
};

module.exports = program =>
	program
		.command('replace-synths')
		.description('Replaces a number of existing synths with a subclass')
		.option(
			'-b, --build-path [value]',
			'Path to a folder hosting compiled files from the "build" step in this script',
			path.join(__dirname, '..', '..', '..', BUILD_FOLDER)
		)
		.option(
			'-c, --contract-deployment-gas-limit <value>',
			'Contract deployment gas limit',
			parseInt,
			7e6
		)
		.option(
			'-d, --deployment-path <value>',
			`Path to a folder that has your input configuration file ${CONFIG_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
		)
		.option('-g, --gas-price <value>', 'Gas price in GWEI', 1)
		.option('-m, --method-call-gas-limit <value>', 'Method call gas limit', parseInt, 15e4)
		.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'kovan')
		.option(
			'-s, --synths-to-replace <value>',
			'The list of synths to replace',
			(val, memo) => {
				memo.push(val);
				return memo;
			},
			[]
		)
		.option('-u, --subclass <value>', 'Subclass to switch into')
		.option('-x, --max-supply-to-purge-in-usd [value]', 'For PurgeableSynth, max supply', 1000)
		.action(
			async ({
				network,
				buildPath,
				deploymentPath,
				gasPrice,
				methodCallGasLimit,
				contractDeploymentGasLimit,
				subclass,
				synthsToReplace,
				maxSupplyToPurgeInUsd,
			}) => {
				ensureNetwork(network);
				ensureDeploymentPath(deploymentPath);

				const { synths, synthsFile, deployment, deploymentFile } = loadAndCheckRequiredSources({
					deploymentPath,
					network,
				});

				if (synthsToReplace.length < 1) {
					console.log(yellow('No synths provided. Please use --synths-to-remove option'));
					return;
				}

				if (!subclass) {
					console.log(yellow('Please provide a valid Synth subclass'));
					return;
				}

				// now check the subclass is valud
				const compiledSourcePath = path.join(buildPath, COMPILED_FOLDER);
				const foundSourceFileForSubclass = fs
					.readdirSync(compiledSourcePath)
					.filter(name => /^.+\.json$/.test(name))
					.find(entry => new RegExp(`^${subclass}.json$`).test(entry));

				if (!foundSourceFileForSubclass) {
					console.log(
						yellow(`Cannot find a source file called: ${subclass}.json. Please check the name`)
					);
					return;
				}

				// sanity-check the synth list
				for (const synth of synthsToReplace) {
					if (synths.filter(({ name }) => name === synth).length < 1) {
						console.error(red(`Synth ${synth} not found!`));
						process.exitCode = 1;
						return;
					} else if (['XDR', 'sUSD'].indexOf(synth) >= 0) {
						console.error(red(`Synth ${synth} cannot be replaced`));
						process.exitCode = 1;
						return;
					}
				}

				const { providerUrl, privateKey, etherscanLinkPrefix } = loadConnections({ network });

				console.log(gray('Loading the compiled contracts locally...'));
				const { compiled } = loadCompiledFiles({ buildPath });

				const deployer = new Deployer({
					compiled,
					config: {}, // we don't care what config we pass the deployer - we will force override
					deployment: {}, // we don't need our deployer to lookup existing contracts when deploying
					gasPrice,
					methodCallGasLimit,
					contractDeploymentGasLimit,
					privateKey,
					providerUrl,
				});

				const { web3, account } = deployer;

				console.log(gray(`Using account with public key ${account}`));
				console.log(
					gray(
						`Using gas of ${gasPrice} GWEI with a limit of ${methodCallGasLimit} (methods), ${contractDeploymentGasLimit} (deployment)`
					)
				);

				const currentGasPrice = await web3.eth.getGasPrice();
				console.log(
					gray(`Current gas price is approx: ${w3utils.fromWei(currentGasPrice, 'gwei')} GWEI`)
				);

				// convert the list of synths into a list of deployed contracts
				const deployedSynths = synthsToReplace.map(currencyKey => {
					const { address: synthAddress } = deployment.targets[`Synth${currencyKey}`];
					const { address: proxyAddress, source: proxySource } = deployment.targets[
						`Proxy${currencyKey}`
					];
					const { address: tokenStateAddress, source: tokenStateSource } = deployment.targets[
						`TokenState${currencyKey}`
					];

					// const { abi: synthABI } = deployment.sources[synthSource];
					const { abi: tokenStateABI } = deployment.sources[tokenStateSource];
					const { abi: proxyABI } = deployment.sources[proxySource];

					// const Synth = new web3.eth.Contract(synthABI, synthAddress);
					const TokenState = new web3.eth.Contract(tokenStateABI, tokenStateAddress);
					const Proxy = new web3.eth.Contract(proxyABI, proxyAddress);

					return {
						// Synth,
						TokenState,
						Proxy,
						currencyKey,
						synthAddress,
					};
				});

				const totalSupplies = {};
				try {
					const totalSupplyList = await Promise.all(
						deployedSynths.map(({ Synth }) => Synth.methods.totalSupply().call())
					);
					totalSupplyList.forEach(
						(supply, i) => (totalSupplies[synthsToReplace[i]] = totalSupplyList[i])
					);
				} catch (err) {
					console.error(
						red(
							'Cannot connect to existing contracts. Please double check the deploymentPath is correct for the network allocated'
						)
					);
					process.exitCode = 1;
					return;
				}
				try {
					await confirmAction(
						cyan(
							`${yellow(
								'⚠ WARNING'
							)}: This action will replace the following synths into ${subclass} on ${network}:\n- ${synthsToReplace
								.map(
									synth =>
										synth + ' (totalSupply of: ' + w3utils.fromWei(totalSupplies[synth]) + ')'
								)
								.join('\n- ')}`
						) + '\nDo you want to continue? (y/n) '
					);
				} catch (err) {
					console.log(gray('Operation cancelled'));
					return;
				}

				const { address: synthetixAddress, source } = deployment.targets['Synthetix'];
				const { abi: synthetixABI } = deployment.sources[source];
				const Synthetix = new web3.eth.Contract(synthetixABI, synthetixAddress);
				const feePoolAddress = deployment.targets['FeePool'].address;
				const exchangeRatesAddress = deployment.targets['ExchangeRates'].address;

				const updatedDeployment = JSON.parse(JSON.stringify(deployment));
				const updatedSynths = JSON.parse(JSON.stringify(synths));

				for (const { currencyKey, synthAddress, Proxy, TokenState } of deployedSynths) {
					const synthContractName = `Synth${currencyKey}`;

					const currentSynthInSNX = await Synthetix.methods.synths(toBytes4(currencyKey)).call();

					if (synthAddress !== currentSynthInSNX) {
						console.error(
							red(
								`Synth address in Synthetix for ${currencyKey} is different from what's deployed in Synthetix to the local ${DEPLOYMENT_FILENAME} of ${network} \ndeployed: ${yellow(
									currentSynthInSNX
								)}\nlocal:    ${yellow(synthAddress)}`
							)
						);
						process.exitCode = 1;
						return;
					}

					// STEPS
					// 1. set old TokenState.setTotalSupply(0) // owner
					runStep({
						contract: `TokenState${currencyKey}`,
						target: TokenState,
						read: 'totalSupply',
						expected: input => input === '0',
						write: 'setTotalSupply',
						writeArg: '0',
						owner: account,
						gasPrice,
						gasLimit: methodCallGasLimit,
						etherscanLinkPrefix,
					});

					// 2. invoke Synthetix.removeSynth(currencyKey) // owner
					runStep({
						contract: 'Synthetix',
						target: Synthetix,
						read: 'synths',
						readArg: currencyKey,
						expected: input => !w3utils.isAddress(input),
						write: 'removeSynth',
						writeArg: currencyKey,
						owner: account,
						gasPrice,
						gasLimit: methodCallGasLimit,
						etherscanLinkPrefix,
					});

					// 3. use Deployer to deploy
					const additionalConstructorArgsMap = {
						PurgeableSynth: [exchangeRatesAddress, w3utils.toWei(maxSupplyToPurgeInUsd)],
						// future subclasses...
					};
					const replacementSynth = deployer.deploy({
						name: `Synth${currencyKey}`,
						source: subclass,
						force: true,
						args: [
							Proxy.options.address,
							TokenState.options.address,
							Synthetix.options.address,
							feePoolAddress,
							`Synth ${currencyKey}`,
							currencyKey,
							account,
							toBytes4(currencyKey),
						].concat(additionalConstructorArgsMap[subclass]),
					});

					// 4. Synthetix.addSynth(newone) // owner
					runStep({
						contract: 'Synthetix',
						target: Synthetix,
						read: 'synths',
						readArg: currencyKey,
						expected: input => input === replacementSynth.options.address,
						write: 'addSynth',
						writeArg: replacementSynth.options.address,
						owner: account,
						gasPrice,
						gasLimit: methodCallGasLimit,
						etherscanLinkPrefix,
					});

					// 5. old TokenState.setAssociatedContract(newone) // owner
					runStep({
						contract: `TokenState${currencyKey}`,
						target: TokenState,
						read: 'associatedContract',
						expected: input => input === replacementSynth.options.address,
						write: 'setAssociatedContract',
						writeArg: replacementSynth.options.address,
						owner: account,
						gasPrice,
						gasLimit: methodCallGasLimit,
						etherscanLinkPrefix,
					});

					// 6. old Proxy.setTarget(newone) // owner
					runStep({
						contract: `Proxy${currencyKey}`,
						target: Proxy,
						read: 'target',
						expected: input => input === replacementSynth.options.address,
						write: 'setTarget',
						writeArg: replacementSynth.options.address,
						owner: account,
						gasPrice,
						gasLimit: methodCallGasLimit,
						etherscanLinkPrefix,
					});

					// 7. newone.setTotalSupply(totalSupplyList[...])
					runStep({
						contract: synthContractName,
						target: replacementSynth,
						read: 'totalSupply',
						expected: input => input === totalSupplies[currencyKey],
						write: 'setTotalSupply',
						writeArg: totalSupplies[currencyKey],
						owner: account,
						gasPrice,
						gasLimit: methodCallGasLimit,
						etherscanLinkPrefix,
					});

					// update the deployment.json file for new Synth target
					updatedDeployment.targets[synthContractName] = {
						name: synthContractName,
						address: replacementSynth.options.address,
						source: subclass,
						network,
						link: `${etherscanLinkPrefix}/address/${replacementSynth.options.address}`,
						timestamp: new Date(),
						txn: '',
					};
					// and the source ABI (in case it's not already there)
					updatedDeployment.sources[subclass] = {
						bytecode: compiled[subclass].evm.bytecode.object,
						abi: compiled[subclass].abi,
					};
					fs.writeFileSync(deploymentFile, stringify(updatedDeployment));

					// and update the synths.json file
					const synthToUpdateInJSON = updatedSynths.find(({ name }) => name === currencyKey);
					synthToUpdateInJSON.subclass = subclass;
					fs.writeFileSync(synthsFile, stringify(updatedSynths));
				}
			}
		);