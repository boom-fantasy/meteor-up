import path from "path";
import debug from "debug";
import nodemiral from "nodemiral";
import uuid from "uuid";
import * as _ from "underscore";
import {runTaskList, getDockerLogs} from "../utils";
import buildApp from "./build.js";
const log = debug('mup:module:meteor');

export function help(/* api */) {
    log('exec => mup meteor help');
    console.log('mup meteor', Object.keys(this));
}

export function logs(api) {
    log('exec => mup meteor logs');
    const config = api.getConfig().meteor;
    if (!config) {
        console.error('error: no configs found for meteor');
        process.exit(1);
    }

    const args     = api.getArgs();
    const sessions = api.getSessions(['meteor']);
    return getDockerLogs(config.name, sessions, args);
}

export function setup(api) {
    log('exec => mup meteor setup');
    const config = api.getConfig().meteor;
    if (!config) {
        console.error('error: no configs found for meteor');
        process.exit(1);
    }

    const list = nodemiral.taskList('Setup Meteor');

    list.executeScript('Setup Environment', {
        script: path.resolve(__dirname, 'assets/meteor-setup.sh'), vars: {
            name: config.name,
        },
    });

    if (config.ssl) {
        const basePath = api.getBasePath();

        if (config.ssl.upload !== false) {
            list.copy('Copying SSL Certificate Bundle', {
                src: path.resolve(basePath, config.ssl.crt), dest: '/opt/' + config.name + '/config/bundle.crt'
            });

            list.copy('Copying SSL Private Key', {
                src: path.resolve(basePath, config.ssl.key), dest: '/opt/' + config.name + '/config/private.key'
            });
        }

        list.executeScript('Verifying SSL Configurations', {
            script: path.resolve(__dirname, 'assets/verify-ssl-config.sh'), vars: {
                name: config.name
            },
        });
    }

    const sessions = api.getSessions(['meteor']);

    return runTaskList(list, sessions);
}

export function push(api,session,force_redeploy) {
    log('exec => mup meteor push');
    const config = api.getConfig().meteor;
    if (!config) {
        console.error('error: no configs found for meteor');
        process.exit(1);
    }
    if (!config.docker) {
        if (config.dockerImage) {
            config.docker = {image: config.dockerImage};
            delete config.dockerImage;
        }
        else {
            config.docker = {image: 'kadirahq/meteord'};
        }
    }

    var buildOptions = config.buildOptions || {};
    var args         = api.getArgs();

    if (_.any(args, (a) => a&&(a.localeCompare('--redeploy')==0))||force_redeploy) {

        buildOptions.allow_reuse = true;
    }

    buildOptions.buildLocation = buildOptions.buildLocation || path.resolve('/tmp', uuid.v4());

    console.log('Building App Bundle Locally');

    var bundlePath = path.resolve(buildOptions.buildLocation, 'bundle.tar.gz');
    const appPath  = path.resolve(api.getBasePath(), config.path);

    return buildApp(appPath, buildOptions)
        .then(() => {

            config.log = config.log || {
                    opts: {
                        'max-size'                    : '100m', 'max-file': 10
                    }
                };
            const list = nodemiral.taskList('Pushing Meteor');

            list.copy('Pushing Meteor App Bundle to The Server', {
                src        : bundlePath,
                dest       : '/opt/' + config.name + '/tmp/bundle.tar.gz',
                progressBar: config.enableUploadProgressBar
            });

            list.copy('Pushing the Startup Script', {
                src : path.resolve(__dirname, 'assets/templates/start.sh'),
                dest: '/opt/' + config.name + '/config/start.sh',
                vars: {
                    appName      : config.name,
                    useLocalMongo: api.getConfig().mongo ? 1 : 0,
                    port         : config.env.PORT || 80,
                    sslConfig    : config.ssl,
                    logConfig    : config.log,
                    volumes      : config.volumes,
                    docker       : config.docker
                }
            });

             session = session||api.getSessions(['meteor']);
            return runTaskList(list, session);
        });
}

export function envconfig(api,sessions) {
    log('exec => mup meteor envconfig');
    const config = api.getConfig().meteor;
    const servers = api.getConfig().servers;
    let current_server = '';
    try {
        for (let s in servers) {

            if (servers[s].host == sessions._host) {
                current_server = s;
                break;
            }
        }
    }catch(ex){
        console.log(ex)
    }



    if (!config) {
        console.error('error: no configs found for meteor');
        process.exit(1);
    }

    const list = nodemiral.taskList('Configuring  Meteor Environment Variables');

    var env             = _.clone(config.env);
    _.extend(env,config.servers[current_server]);


    env.METEOR_SETTINGS = JSON.stringify(api.getSettings());
    // sending PORT to the docker container is useless.
    // It'll run on PORT 80 and we can't override it
    // Changing the port is done via the start.sh script
    delete env.PORT;

    list.copy('Sending Environment Variables', {
        src : path.resolve(__dirname, 'assets/templates/env.list'),
        dest: '/opt/' + config.name + '/config/env.list',
        vars: {
            env: env || {}, appName: config.name
        }
    });
    sessions = sessions||api.getSessions(['meteor']);
    return runTaskList(list, sessions);
}

export function start(api,sessions) {
    log('exec => mup meteor start');
    const config = api.getConfig().meteor;
    if (!config) {
        console.error('error: no configs found for meteor');
        process.exit(1);
    }

    const list = nodemiral.taskList('Start Meteor');

    list.executeScript('Start Meteor', {
        script: path.resolve(__dirname, 'assets/meteor-start.sh'), vars: {
            appName: config.name
        }
    });

    list.executeScript('Verifying Deployment', {
        script: path.resolve(__dirname, 'assets/meteor-deploy-check.sh'), vars: {
            deployCheckWaitTime: config.deployCheckWaitTime || 60, appName: config.name, port: config.env.PORT || 80
        }
    });

    sessions = sessions||api.getSessions(['meteor']);
    return runTaskList(list, sessions);
}

export function deploy(api,sessions,force_redeploy) {
    log('exec => mup meteor deploy');
    const config = api.getConfig().meteor;
    if (!config) {
        console.error('error: no configs found for meteor');
        process.exit(1);
    }
    if(force_redeploy && (!sessions || sessions.length==0)) {
     return api.done();
    }
    else {
        sessions = sessions || api.getSessions(['meteor']);
        if (Array.isArray(sessions)) {
            let session = sessions.shift();

            return deploy(api, session,force_redeploy)
                .then(()=>{deploy(api, sessions, true)});
        }
        else {

            return push(api, sessions, force_redeploy)
                .then(() => envconfig(api, sessions))
                .then(() => start(api, sessions));
        }
    }
}

export function stop(api) {
    log('exec => mup meteor stop');
    const config = api.getConfig().meteor;
    if (!config) {
        console.error('error: no configs found for meteor');
        process.exit(1);
    }

    const list = nodemiral.taskList('Stop Meteor');

    list.executeScript('Stop Meteor', {
        script: path.resolve(__dirname, 'assets/meteor-stop.sh'), vars: {
            appName: config.name
        }
    });

    const sessions = api.getSessions(['meteor']);
    return runTaskList(list, sessions)  .then(()=> {
        api.done()
    });
}
