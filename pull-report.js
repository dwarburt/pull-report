#!/usr/bin/env node
"use strict";

/**
 * Pull request notifications.
 */
var fs = require("fs");
var path = require("path");
var pkg = require("./package.json");

var _ = require("underscore");
var async = require("async");
var handlebars = require("handlebars");
var program = require("commander");
var iniparser = require("iniparser");
var GitHubApi = require("github");

var NOT_FOUND = -1;

var github;

/**
 * Get Items for organization (PRs or Issues).
 *
 * @param {Object}    opts              Options.
 * @param {String}    opts.org          Organization name
 * @param {String}    opts.users        Users to filter (or `null`)
 * @param {Bool}      opts.pullRequests Include pull requests
 * @param {Bool}      opts.issues       Include issues
 * @param {String}    opts.host         GitHub Enterprise API host URL
 * @param {Bool}      opts.includeUrl   Include url in results
 * @param {Function}  callback          Calls back with `(err, data)`
 * @returns {void}
 */
var getItems = function (opts, callback) {
  // Actions.
  async.auto({
    repos: function (cb) {
      github.repos.getFromOrg({
        type: opts.repoType,
        org: opts.org,
        per_page: 100 // eslint-disable-line camelcase
      }, cb);
    },

    items: ["repos", function (cb, results) {
      var repos = _.chain(results.repos)
        .map(function (repo) { return [repo.name, repo]; })
        .object()
        .value();

      if (opts.repo != null) {
        results.repos = results.repos.filter( repo => repo.name == opts.repo )
      }
      // Iterate repositories
      async.each(results.repos, function (repo, repoCb) {
        // Iterate type of item to request.
        async.parallel([
          // Type: Pull Requests
          function (typeCb) {
            if (!opts.pullRequests) { return typeCb(); }
            

            github.pullRequests.getAll({
              user: opts.org,
              repo: repo.name,
              state: opts.state,
              per_page: 100 // eslint-disable-line camelcase
            }, function (err, items) {
              console.log(`Got ${items && items.length} issues for: ${opts.org}/${repo.name} in state ${opts.state}`);
              if (items && items.length) {
                delete items.meta;
                repos[repo.name].items = items;
              }

              return typeCb(err);
            });
          },

          // Type: Issues
          function (typeCb) {
            if (!opts.issues) { return typeCb(); }

            github.issues.repoIssues({
              user: opts.org,
              repo: repo.name,
              state: opts.state,
              per_page: 100 // eslint-disable-line camelcase
            }, function (err, items) {
              if (items && items.length) {
                delete items.meta;
                repos[repo.name].items = items;
              }

              return typeCb(err);
            });
          }

        ], repoCb);


      }, function (err) {
        return cb(err, repos);
      });
    }]

  }, function (err, results) {
    if (err) { return callback(err); }

    var repos = {};
    var entUrlRe = /api\/v[0-9]\/repos\//;
    var orgUrl = null;

    // Iterate Repos.
    _.chain(results.items)
      .filter(function (repo) { return repo.items && repo.items.length; })
      .sort(function (repo) { return repo.name; })
      .map(function (repo) {
        // Add in owner URL.
        orgUrl = orgUrl || repo.owner.html_url;

        // Starting data.
        var repoData = {
          name: repo.name,
          url: repo.html_url
        };

        // Iterate PRs.
        repoData.items = _.chain(repo.items)
          .sort(function (pr) { return pr.number; })
          .map(function (pr) {
            var url = pr.url.replace(/pulls\/([0-9]+)$/, "pull/$1");

            // Mutate URLs to actual PR urls.
            if (entUrlRe.test(url)) {
              // Undo Enterprise hack.
              url = url.replace(entUrlRe, "");
            } else {
              // Normal GitHub.
              url = url.replace(
                "https://api.github.com/repos/",
                "https://github.com/");
            }

            return {
              userUrl: "https://" + (opts.host || "github.com"),
              user: pr.user ? pr.user.login : null,
              assignee: pr.assignee ? pr.assignee.login : null,
              number: pr.number,
              title: pr.title,
              url: opts.includeUrl ? url : null
            };
          })
          .filter(function (pr) {
            // Limit to assigned / requesting users.
            return !opts.users ||
              _.contains(opts.users, pr.assignee) ||
              _.contains(opts.users, pr.user);
          })
          .value();

        // Add in repo if 1+ filtered PRs.
        if (repoData.items.length > 0) {
          repos[repo.name] = repoData;
        }
      });

    // Piggy back owner url off first PR.
    callback(null, {
      org: opts.org,
      orgUrl: orgUrl,
      repos: repos
    });
  });
};

var list = function (val) {
  return val.split(",");
};

var validateArgs = function (opts) {
  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------
  if (!(opts.org || []).length) {
    throw new Error("Must specify 1+ organization names");
  }
  // If we have a token, no need for user/password
  if (!opts.ghToken && !(opts.ghUser && opts.ghPass)) {
    throw new Error("Must specify GitHub user / pass in .gitconfig or " +
      "on the command line");
  }
  if (!/^(open|closed)$/i.test(opts.state)) {
    throw new Error("Invalid state: " + opts.state);
  }
  if (!/^(all|public|member)$/i.test(opts.repoType)) {
    throw new Error("Invalid repo type: " + opts.repoType);
  }
  if (!(opts.issueType || opts.org.issueType)) {
    opts.issueType = ["pull-request"]; // default
  }
  opts.issueType.forEach(function (type) {
    if (["pull-request", "issue"].indexOf(type) === NOT_FOUND) {
      throw new Error("Invalid issue type: " + type);
    }
  });
};

var pullReport = function (opts, callback) {
  validateArgs(opts);

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------
  // Set up github auth.
  github = new GitHubApi({
    // required
    version: "3.0.0",
    // optional
    timeout: 5000
  });

  // Hack in GH enterprise API support.
  //
  // Note: URL forms are different:
  // https://ORG_HOST/api/v3/API_PATH/...
  if (opts.host && github.version === "3.0.0") {
    // Allow for proxy HTTPS mismatch. This is obviously an unsatisfactory
    // solution, but temporarily gets past:
    // `UNABLE_TO_VERIFY_LEAF_SIGNATURE` errors.
    if (opts.insecure) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    // Patch host.
    github.constants.host = opts.host;

    // Patch routes with "/api/v3"
    _.each(github[github.version].routes, function (group/*, groupName*/) {
      _.each(group, function (route/*, routeName*/) {
        if (route.url) {
          route.url = "/api/v3" + route.url;
        }
      });
    });
  }

  // Authenticate.
  if (opts.ghToken) {
    // Favor OAuth2
    github.authenticate({
      type: "oauth",
      token: opts.ghToken
    });
  } else {
    // Otherwise basic auth with user/pass
    github.authenticate({
      type: "basic",
      username: opts.ghUser,
      password: opts.ghPass
    });
  }

  // --------------------------------------------------------------------------
  // Iterate PRs for Organizations.
  // --------------------------------------------------------------------------
  // Get PRs for each org in parallel, then display in order.
  async.map(opts.org, function (org, cb) {
    getItems({
      repoType: opts.repoType,
      org: org,
      pullRequests: opts.issueType.indexOf("pull-request") > NOT_FOUND,
      issues: opts.issueType.indexOf("issue") > NOT_FOUND,
      users: opts.user,
      state: opts.state,
      host: opts.host,
      repo: opts.repo,
      includeURL: opts.prUrl || opts.html
    }, cb);
  }, callback);
};

// Main.
if (require.main === module) {
  var HOME_PATH = process.env[/^win/.test(process.platform) ? "USERPROFILE" : "HOME"];
  var GIT_CONFIG_PATH = path.join(HOME_PATH, ".gitconfig");
  var GIT_CONFIG = null;

  // Try and get the .gitconfig.
  try {
    GIT_CONFIG = iniparser.parseSync(GIT_CONFIG_PATH);
  } catch (err) {
    // Passthrough.
  }

  var ghConfig = GIT_CONFIG && GIT_CONFIG.github ? GIT_CONFIG.github : {};

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------
  // Parse command line arguments.
  program
    .version(pkg.version)

    .option("-o, --org [orgs]", "Comma-separated list of 1+ organizations", list)
    .option("-u, --user [users]", "Comma-separated list of 0+ users", list)
    .option("-H, --host <name>", "GitHub Enterprise API host URL")
    .option("-s, --state <state>", "State of issues (default: open)", "open")
    .option("-i, --insecure", "Allow unauthorized TLS (for proxies)", false)
    .option("-t, --tmpl <path>", "Handlebars template path")
    .option("--html", "Display report as HTML", false)
    .option("--gh-user <username>", "GitHub user name", null)
    .option("--gh-pass <password>", "GitHub pass", null)
    .option("--gh-token <token>", "GitHub token", null)
    .option("--pr-url", "Add pull request or issue URL to output", false)
    .option("--repo-type <type>", "Repo type (default: all|member|private)", "all")
    .option("--repo <repo name>", "Return only the named repository", null)
    .option("--issue-type [types]",
      "Comma-separated list of issue types (default: pull-request|issue)", list)
    .parse(process.argv);

  // Add defaults from configuration, in order of precendence.
  // 1. `--gh-token`
  if (!program.ghToken && !(program.ghUser && program.ghPass)) {
    // 2. `--gh-user`/`--gh-pass` w/ .gitconfig:github:user`/`
    //    .gitconfig:github:password`
    if (program.ghUser && !program.ghPass && ghConfig.password) {
      program.ghPass = ghConfig.password;
    } else if (!program.ghUser && ghConfig.user && program.ghPass) {
      program.ghUser = ghConfig.user;

    // 3. `.gitconfig:github:token`
    } else if (ghConfig.token) {
      program.ghToken = ghConfig.token;

    // 4. `.gitconfig:github:user` `.gitconfig:github:password`
    } else if (ghConfig.user && ghConfig.pass) {
      program.ghUser = ghConfig.user;
      program.ghPass = ghConfig.password;
    }
  }

  // --------------------------------------------------------------------------
  // Template
  // --------------------------------------------------------------------------
  var tmplPath = path.join(__dirname, "templates/text.hbs");
  if (program.html) {
    tmplPath = path.join(__dirname, "templates/html.hbs");
  } else if (program.tmpl) {
    tmplPath = program.tmpl;
  }

  var tmplStr = fs.readFileSync(tmplPath).toString();
  var tmpl = handlebars.compile(tmplStr);

  pullReport(program, function (err, results) {
    if (err) { throw err; }

    // Write output.
    process.stdout.write(tmpl(results));
  });
}

module.exports = pullReport;
