var AWS = require("aws-sdk");
const util = require("util");
var cwl = new AWS.CloudWatchLogs({apiVersion: '2014-03-28'});

async function createSubscriptionFilter(lambdaLogGroupName, destinationArn, roleArn) {
    if (destinationArn.startsWith("arn:aws:lambda")){
        var params = {
            destinationArn: destinationArn,
            filterName: 'SumoLGLBDFilter',
            filterPattern: '',
            logGroupName: lambdaLogGroupName
        };
    } else {
        var params = {
            destinationArn: destinationArn,
            filterName: 'SumoLGLBDFilter',
            filterPattern: '',
            logGroupName: lambdaLogGroupName,
            roleArn: roleArn
        };
    }

    // handle case where subscription filter exists/case where loggroup generated by target lambda
    try {
        await util.promisify(cwl.putSubscriptionFilter.bind(cwl))(params);
        console.log("Successfully subscribed logGroup: ", lambdaLogGroupName);
    } catch (err) {
        console.log("Error in subscribing", lambdaLogGroupName, err);
        throw err;
    }
}

function filterLogGroups(event, logGroupRegex) {
    logGroupRegex = new RegExp(logGroupRegex, "i");
    let logGroupName = event.detail.requestParameters.logGroupName;
    if (logGroupName.match(logGroupRegex) && event.detail.eventName === "CreateLogGroup") {
        return true;
    }
    let lg_tags = event.detail.requestParameters.tags;
    if (process.env.LOG_GROUP_TAGS && lg_tags) {
        console.log("tags in loggroup: ", lg_tags);
        var tags_array = process.env.LOG_GROUP_TAGS.split(",");
        let tag, key, value;
        for (let i = 0; i < tags_array.length; i++) {
          tag = tags_array[i].split("=");
          key = tag[0].trim();
          value = tag[1].trim();
          if (lg_tags[key] && lg_tags[key]==value) {
              return true;
          }
        }
    }
    return false;
}

async function subscribeExistingLogGroups(logGroups, counter) {
    var logGroupRegex = new RegExp(process.env.LOG_GROUP_PATTERN, "i");
    var destinationArn = process.env.DESTINATION_ARN;
    var roleArn = process.env.ROLE_ARN;
    const failedLogGroupNames = [];
    await logGroups.reduce(async (previousPromise, nextLogGroup) => {
        await previousPromise;
        const { logGroupName } = nextLogGroup;
        if (!logGroupName.match(logGroupRegex)) {
            console.log("Unmatched logGroup: ", logGroupName);
            return Promise.resolve();
        } else {
            return createSubscriptionFilter(logGroupName, destinationArn, roleArn).catch( function (err) {
                if (err && err.code == "ThrottlingException") {
                    failedLogGroupNames.push({logGroupName: logGroupName});
                }
            });
        }
    }, Promise.resolve());

    if (counter < 4 && failedLogGroupNames.length > 0) {
        console.log("Retrying Subscription for Failed Log Groups due to throttling with counter number as " + counter);
        await subscribeExistingLogGroups(failedLogGroupNames, counter + 1);
    }
}

function processExistingLogGroups(token, context, errorHandler) {
    var params = {limit: 50};
    if (token) {
        params = {
          limit: 50,
          // logGroupNamePrefix: '',
          nextToken: token
        };
    }
    var p = new Promise(function(resolve, reject) {
        cwl.describeLogGroups(params, function(err, data) {
            if (err) {
                console.log("error in fetching logGroups", err, err.stack);
                reject(err);
            } else {
                console.log("fetched logGroups: " + data.logGroups.length + " nextToken: " + data.nextToken);
                resolve(data);
            }
        });
    });
    var cb = async function (data) {
        await subscribeExistingLogGroups(data.logGroups, 0);
        if (data.nextToken) {// if next set of log groups exists, invoke next instance of lambda
            console.log("Log Groups remaining...Calling the lambda again with token " + data.nextToken);
            invoke_lambda(context, data.nextToken, errorHandler);
            console.log("Lambda invoke complete with token " + data.nextToken);
        } else {
            console.log("All Log Groups are subscribed to Destination Type " + process.env.DESTINATION_ARN);
            errorHandler(null, "Success");
        }
    };
    return p.then(cb).catch(function (err) {
        errorHandler(err, "Error in fetching logGroups");
    });
}

function invoke_lambda(context, token, errorHandler) {
    var lambda = new AWS.Lambda();
    var payload = {"existingLogs": "true", "token": token};
    lambda.invoke({
        InvocationType: 'Event',
        FunctionName: context.functionName,
        Payload: JSON.stringify(payload),
    }, errorHandler);
}

function processEvents(env, event, errorHandler) {

    var logGroupName = event.detail.requestParameters.logGroupName;
    if (filterLogGroups(event, env.LOG_GROUP_PATTERN)) {
        console.log("Subscribing: ", logGroupName, env.DESTINATION_ARN);
        createSubscriptionFilter(logGroupName, env.DESTINATION_ARN, env.ROLE_ARN).catch (function (err) {
            errorHandler(err, "Error in Subscribing.");
        });
    } else {
        console.log("Unmatched: ", logGroupName, env.DESTINATION_ARN);
    }

}

exports.handler = function (event, context, callback) {
    console.log("Invoking Log Group connector function");
    function errorHandler(err, msg) {
        if (err) {
            console.log(err, msg);
            callback(err);
        } else {
            callback(null, "Success");
        }
    }
    if (event.existingLogs  == "true") {
        processExistingLogGroups(event.token, context, errorHandler);
    } else {
        processEvents(process.env, event, errorHandler);
    }
};
